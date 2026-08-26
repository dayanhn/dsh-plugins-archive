// dsh-wx-daily — WeChat 公众号 article panel for DeepSeek Harness.
//
// Host half.
//   • model tool wx_collect: pull every configured account's articles in a
//     same-day / N-day / custom window through a LOCAL 微信读书 session
//     (weread-mp-fetcher in a dedicated Chrome profile — no third-party
//     relay; no dedup, each run is a fresh view), optional LLM summary,
//   • human command /wx: today's collection + summary from the GUI without a
//     model turn,
//   • webServer JSON routes (/wx-daily/*): latest view / collect / accounts /
//     status / on-demand per-article summary — consumed by the sidebar
//     公众号 tab (client half).
//
// Out-of-tree constraint: this plugin does NOT append custom session events
// — the persistence read path refuses unknown event types that are not
// marked ignorable, and out-of-tree plugins cannot mark them. Durable state
// is dataDir/latest.json (+ accounts.json); the GUI reads it through the
// webServer routes.
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { collect, windowBounds, explainSrcErr, runFetcher, BOOK_ID_RE } from './collect.js'
import { summarizeItems, renderSummaryMarkdown, summarizeArticle } from './summary.js'

export const name = 'dsh-wx-daily'

// tools / llm / commands are all dsh-base rows (web AND headless profiles);
// webServer is optional (headless has none) and read lazily below.
export const inject = ['tools', 'llm', 'commands']

export const Config = z.object({
  /** Local weread-mp-fetcher checkout (the 微信读书 collection channel). */
  fetcherDir: z.string().default('/home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher'),
  /** Pages per account per run (1 page ≈ 70–80 篇); more pages spend more of the daily WeRead request budget. */
  fetcherPages: z.number().step(1).min(1).max(3).default(1),
  /** Auto-launch the dedicated WeRead Chrome (detached, start-chrome.sh) when it is not running at collect time. */
  autoLaunchChrome: z.boolean().default(true),
  /** Data directory: accounts.json, latest.json. */
  dataDir: z.string().default('/home/zzw/work/news/wx-daily'),
  /** IANA zone for the 当天 window. */
  timezone: z.string().default('Asia/Shanghai'),
  /** Summary LLM route; empty = the deployment default (agentDefaultModel). */
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  /** Output token budget for the summary call (thinking models need room). */
  summaryMaxTokens: z.number().step(1).min(1024).max(131072).default(16384),
  /** Reasoning effort for the summary call; 'off' keeps the budget for the JSON. */
  summaryReasoningEffort: z.string().default('off'),
  /** Slash command name (without the leading slash). */
  commandName: z.string().default('wx'),
  /** Cooperative timeout budget for a full collect (+summary) pipeline. */
  collectTimeoutMs: z.number().step(1).min(30000).default(300000),
})

const HERE = path.dirname(fileURLToPath(import.meta.url))

export async function apply(ctx, config) {
  const dataDir = path.resolve(config.dataDir)
  mkdirSync(dataDir, { recursive: true })
  const accountsFile = path.join(dataDir, 'accounts.json')
  const latestFile = path.join(dataDir, 'latest.json')
  // First run: seed the account list from the plugin's built-in default so
  // the user has ONE file to edit for all future additions.
  if (!existsSync(accountsFile)) {
    copyFileSync(path.join(HERE, '..', 'accounts.default.json'), accountsFile)
  }

  function loadAccounts() {
    const raw = JSON.parse(readFileSync(accountsFile, 'utf8'))
    return Array.isArray(raw.accounts) ? raw.accounts : []
  }

  function llmRoute() {
    const adm = ctx.get('agentDefaultModel')
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
    const route = {
      provider: config.llmProvider || (sel && sel.provider) || 'deepseek-official',
      model: config.llmModel || (sel && sel.model) || 'deepseek-v4-flash',
    }
    if (config.summaryReasoningEffort) route.reasoningEffort = config.summaryReasoningEffort
    return route
  }
  const stream = (opts) => ctx.llm.stream({ ...llmRoute(), ...opts })

  // ── dedicated WeRead Chrome (the fetcher's data channel) ────────────────

  /** CDP port of the dedicated Chrome (from the fetcher config; default 9333). */
  function chromePort() {
    try {
      return JSON.parse(readFileSync(path.join(config.fetcherDir, 'config.json'), 'utf8')).chromePort || 9333
    } catch {
      return 9333
    }
  }

  async function chromeReachable(port, signal) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Ensure the dedicated WeRead Chrome is up, auto-launching it (detached,
   * via start-chrome.sh) when it is not. The reachability gate first is what
   * makes the launch safe: the fetcher's README documents that a second
   * launch against a busy profile is silently ignored by Chrome.
   * @param {AbortSignal} [signal]
   * @returns {Promise<number>} the CDP port
   */
  async function ensureChrome(signal) {
    const port = chromePort()
    if (await chromeReachable(port, signal)) return port
    if (!config.autoLaunchChrome) {
      throw new Error('微信读书专用 Chrome 未运行（127.0.0.1:' + port + '）——先执行：screen -dmS wereadchrome sh ' + path.join(config.fetcherDir, 'start-chrome.sh'))
    }
    const { spawn } = await import('node:child_process')
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }
    for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[k]
    const child = spawn('sh', [path.join(config.fetcherDir, 'start-chrome.sh')], { env, stdio: 'ignore', detached: true })
    child.unref()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      if (signal?.aborted) throw new Error('已取消：等待专用 Chrome 启动中被中止')
      if (await chromeReachable(port, signal)) return port
    }
    throw new Error('自动拉起专用 Chrome 失败（20s 内 127.0.0.1:' + port + ' 未就绪）——检查是否有旧 Chrome 进程占着 profile（pgrep -af chrome-profile）或 DISPLAY 是否可用')
  }

  /**
   * The pipeline: fresh collection for the window (+ optional LLM summary).
   * latest.json is OVERWRITTEN every run — no dedup, no seen state.
   * @param window 'today' | '3d' | '7d' | {from, to}
   * @param withSummary include the LLM 要点 block
   */
  async function runCollect({ signal, window, withSummary = true } = {}) {
    await ensureChrome(signal)
    const bounds = windowBounds(window || 'today', config.timezone)
    const collected = await collect({ fetcherDir: config.fetcherDir, fetcherPages: config.fetcherPages, accounts: loadAccounts(), window: bounds, signal })
    let summary = null
    let summaryError = ''
    if (withSummary) {
      if (!collected.items.length) {
        summaryError = '时间窗内没有文章，跳过摘要'
      } else {
        try {
          const data = await summarizeItems(collected.items, { stream, signal, maxTokens: config.summaryMaxTokens })
          summary = renderSummaryMarkdown({ data, windowLabel: bounds.label, stats: collected.stats })
        } catch (err) {
          summaryError = String((err && err.message) || err)
        }
      }
    }
    const latest = { ...collected, summary, summaryError, timezone: config.timezone, fetcherDir: config.fetcherDir }
    writeFileSync(latestFile, JSON.stringify(latest, null, 2))
    return latest
  }

  // ── on-demand per-article summary (panel button, outside the pipeline) ──

  /**
   * rid = bookId + '_' + article-URL slug with every `_` re-encoded as `~`
   * (the inverse of the fetcher's `~` → `_` URL rebuild — WeRead's originalId
   * escapes base64url underscores because rid uses `_` as its separator).
   * Fallback for latest.json files written before items carried the rid.
   * @param {string} url mp.weixin article URL
   * @param {string} bookId the account's MP_WXS_ id
   * @returns {string} derived rid, or '' when undecidable
   */
  function deriveRid(url, bookId) {
    const m = String(url || '').match(/mp\.weixin\.qq\.com\/s\/([A-Za-z0-9_-]+)/)
    return m && BOOK_ID_RE.test(String(bookId || '')) ? bookId + '_' + m[1].replace(/_/g, '~') : ''
  }

  /** Fetch one article's body text via the fetcher's --content mode (free of quota). */
  async function fetchArticleText(rid, signal) {
    const { code, stdout, stderr } = await runFetcher(config.fetcherDir, ['--content', rid], signal)
    if (code !== 0) {
      const errText = String(stderr || '').trim()
      throw new Error(explainSrcErr(errText).trim() || 'fetcher 异常退出（code ' + code + '）')
    }
    let body
    try {
      body = JSON.parse(stdout)
    } catch {
      throw new Error('fetcher --content 输出不是合法 JSON')
    }
    if (!body || body.ok !== true || !String(body.text || '').trim()) {
      throw new Error(String((body && body.err) || '文章正文为空'))
    }
    return String(body.text)
  }

  // One pipeline at a time per process (the GUI button and a concurrent /wx
  // must not write latest.json twice).
  let collecting = false

  function formatResult(latest) {
    const lines = []
    lines.push('公众号文章采集完成 · ' + latest.window.label + ' · ' + latest.collectedAt)
    lines.push('各号状态：')
    for (const a of latest.accounts) {
      const mark = a.status === 'ok' ? '✅ ' + a.count + ' 条' : a.status === 'empty' ? '— 无更新' : a.status === 'nofeed' ? '⚠️ 未订阅' : '❌ ' + (a.error || '错误')
      lines.push('  ' + mark + '  ' + a.name)
    }
    if (latest.summary) lines.push('\n' + latest.summary)
    if (latest.summaryError) lines.push('\n（摘要未生成：' + latest.summaryError + '）')
    return lines.join('\n')
  }

  // ── model tool ───────────────────────────────────────────────────────────
  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' } } },
    render: (_a, v) => [{ type: 'text', text: (v && v.text) || '' }],
  }

  const wxCollect = defineTool({
    name: 'wx_collect',
    description: '采集配置公众号在指定时间窗内的文章（通过本机微信读书会话 + 专用 Chrome，无第三方 relay；当天 / 近 N 天 / 自定义日期段；每次全量重采，不做历史去重），返回各号状态与文章列表（标题+链接+时间）。受微信读书每日配额限制（默认 2 次/天）。withSummary=true 时追加一次 LLM「今日要点」摘要。',
    parameters: {
      window: { type: 'string', enum: ['today', '3d', '7d'], description: '时间窗：today=当天（00:00 至现在，Asia/Shanghai），3d=近 3 天，7d=近 7 天；缺省 today。自定义日期段用 from/to。' },
      from: { type: 'string', description: '自定义起始日 YYYY-MM-DD（与 to 同时给出时覆盖 window）' },
      to: { type: 'string', description: '自定义结束日 YYYY-MM-DD（含当天）' },
      withSummary: { type: 'boolean', description: '是否追加 LLM 要点摘要（默认 false，纯列表更快）' },
    },
    output: textOut,
    async execute(args, exec) {
      const a = args || {}
      const win = a.from && a.to ? { from: a.from, to: a.to } : (a.window || 'today')
      if (collecting) throw new Error('采集正在进行中，请稍候再试')
      collecting = true
      try {
        // Tool default is NO summary (fast list for the agent); the /wx
        // command and the panel pass withSummary explicitly.
        const latest = await runCollect({ signal: exec.signal, window: win, withSummary: a.withSummary === true })
        return { ok: true, text: formatResult(latest) }
      } finally {
        collecting = false
      }
    },
    timeoutMs: config.collectTimeoutMs,
  })

  const toolDisposers = [ctx.tools.register(wxCollect)]

  // ── human command /wx ────────────────────────────────────────────────────
  const commandDisposer = ctx.commands.register({
    name: config.commandName,
    description: '采集当天配置公众号的文章（本机微信读书会话 → 时间窗过滤 → LLM 要点摘要），完成后右侧边栏「公众号」tab 可点链接查看原文',
    handler: async (invocation) => {
      try {
        if (collecting) return { kind: 'error', text: '采集正在进行中，请稍候再试' }
        collecting = true
        const latest = await runCollect({ signal: invocation.signal, window: 'today' })
        return { kind: 'success', text: '📮 ' + latest.window.label + ' 采集完成（' + latest.stats.items + ' 篇文章）\n' + (latest.summary || latest.summaryError || '') }
      } catch (err) {
        return { kind: 'error', text: '公众号采集失败：' + String((err && err.message) || err) }
      } finally {
        collecting = false
      }
    },
  })

  // ── webServer JSON routes (web profile only) ─────────────────────────────
  const webServer = ctx.get('webServer')
  const routeDisposers = []
  if (webServer !== undefined) {
    const sendJson = (res, status, body) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }
    const readBody = (req) => new Promise((resolveP) => {
      const chunks = []
      let total = 0
      req.on('data', (c) => {
        total += c.length
        if (total > 1024 * 1024) { req.removeAllListeners('data'); resolveP('{}'); return }
        chunks.push(c)
      })
      req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolveP('{}'))
    })
    const readLatest = () => {
      if (!existsSync(latestFile)) return null
      try { return JSON.parse(readFileSync(latestFile, 'utf8')) } catch { return null }
    }
    /** Diagnostics for the panel's setup banner: fetcher checkout present,
     *  dedicated WeRead Chrome reachable, how many accounts are subscribed. */
    const status = async (signal) => {
      const accts = loadAccounts()
      const s = {
        fetcher: 'missing',
        chrome: 'unreachable',
        accounts: accts.filter((a) => a.enabled !== false).length,
        subscribed: accts.filter((a) => a.enabled !== false && /^MP_WXS_\d+$/.test(a.bookId || '')).length,
      }
      if (existsSync(path.join(config.fetcherDir, 'bin', 'weread.mjs'))) s.fetcher = 'ok'
      // Pure probe (no auto-launch from a GET): a collect is what launches.
      s.chrome = await chromeReachable(chromePort(), signal) ? 'ok' : 'unreachable'
      return s
    }

    const route = {
      kind: 'prefix',
      path: '/wx-daily',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const seg = url.pathname.replace(/^\/wx-daily\/?/, '').split('/').filter(Boolean)
          if (req.method === 'GET' && seg[0] === 'latest' && seg.length === 1) {
            return sendJson(res, 200, { ok: true, data: readLatest() })
          }
          if (req.method === 'GET' && seg[0] === 'accounts' && seg.length === 1) {
            return sendJson(res, 200, { ok: true, accounts: loadAccounts() })
          }
          if (req.method === 'GET' && seg[0] === 'status' && seg.length === 1) {
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), 8000)
            try { return sendJson(res, 200, { ok: true, status: await status(ac.signal) }) } finally { clearTimeout(timer) }
          }
          if (req.method === 'POST' && seg[0] === 'collect' && seg.length === 1) {
            if (collecting) return sendJson(res, 409, { ok: false, error: '采集正在进行中，请稍候再试' })
            const body = JSON.parse((await readBody(req)) || '{}')
            const win = body.from && body.to ? { from: body.from, to: body.to } : (body.window || 'today')
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), config.collectTimeoutMs)
            collecting = true
            try {
              const latest = await runCollect({ signal: ac.signal, window: win, withSummary: body.withSummary !== false })
              return sendJson(res, 200, { ok: true, data: latest })
            } finally {
              collecting = false
              clearTimeout(timer)
            }
          }
          if (req.method === 'POST' && seg[0] === 'summarize' && seg.length === 1) {
            // Independent of the collect single-flight: --content is a free
            // reader-page read and the config write is atomic, so a summary
            // request may run while a collect is in progress.
            const body = JSON.parse((await readBody(req)) || '{}')
            let rid = String(body.rid || '').trim()
            if (!rid) {
              const acc = loadAccounts().find((a) => a.name === body.configName) || {}
              rid = deriveRid(body.url, acc.bookId)
            }
            if (!rid) return sendJson(res, 400, { ok: false, error: '这篇文章没有 rid（旧采集结果）：重新点一次「⚡ 采集」后即可生成摘要' })
            const ac = new AbortController()
            // Safety ceiling for the whole request (body fetch ~2s + one LLM
            // call); not a deployment tunable.
            const timer = setTimeout(() => ac.abort(), 120000)
            try {
              await ensureChrome(ac.signal)
              const text = await fetchArticleText(rid, ac.signal)
              const summary = await summarizeArticle({ title: body.title, account: body.configName, text, stream, signal: ac.signal, maxTokens: config.summaryMaxTokens })
              return sendJson(res, 200, { ok: true, summary })
            } catch (err) {
              const msg = String((err && err.message) || err)
              return sendJson(res, ac.signal.aborted ? 408 : 500, { ok: false, error: ac.signal.aborted ? '生成摘要超时（120s），请重试' : msg })
            } finally {
              clearTimeout(timer)
            }
          }
          return sendJson(res, 404, { ok: false, error: 'unknown wx-daily route' })
        } catch (err) {
          const msg = String((err && err.message) || err)
          return sendJson(res, /正在进行中/.test(msg) ? 409 : 500, { ok: false, error: msg })
        }
      },
    }
    routeDisposers.push(webServer.register(route))
  }

  // Registrations are effects: the setup returns the teardown disposer,
  // which runs only when this plugin's fiber unmounts.
  ctx.effect(() => () => {
    toolDisposers.forEach((d) => d())
    commandDisposer()
    routeDisposers.forEach((d) => d())
  }, 'dsh-wx-daily.dispose')
}
