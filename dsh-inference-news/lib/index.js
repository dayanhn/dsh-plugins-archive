// dsh-inference-news — daily LLM-inference news digest for DeepSeek Harness.
//
// Host half.
//   • model tools: news_collect (read-only candidates + source status) and
//     news_digest (full pipeline: collect -> auxiliary-LLM curation ->
//     deterministic markdown render -> digests/YYYY-MM-DD.md -> seen state),
//   • human command /news: runs the same pipeline from the GUI without a
//     model turn,
//   • webServer JSON routes (/inference-news/...): digest list / full text /
//     on-demand generate — consumed by the sidebar 日报 tab (client half),
//   • the collector (lib/collect.js) is the battle-tested M0 script: arXiv,
//     HF Daily Papers, 23 GitHub release feeds (incl. vllm-ascend and the
//     Huawei Ascend stack), tiered RSS blogs, Hacker News; proxy env aware
//     with direct fallback, per-source failure isolation.
//
// Out-of-tree constraint: this plugin does NOT append custom session events —
// the persistence read path refuses unknown event types that are not marked
// ignorable, and out-of-tree plugins cannot mark them. Durable state is the
// markdown file + seen.json; the GUI reads them through the webServer routes.
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { runCollect, recordSeen, normUrl, scoreItem } from './collect.js'
import { curateItems, renderDigest, writeDigest, digestDate, fullViewName } from './digest.js'

export const name = 'dsh-inference-news'

// tools / llm / commands are all dsh-base rows (web AND headless profiles);
// webServer is optional (headless has none) and read lazily below.
export const inject = ['tools', 'llm', 'commands']

export const Config = z.object({
  /** Absolute directory holding YYYY-MM-DD.md digests. */
  outputDir: z.string().default('/home/zzw/work/news/digests'),
  /** URL dedupe state file (14-day report window, 30-day retention). */
  stateFile: z.string().default('/home/zzw/work/news/seen.json'),
  /** Last collection's candidate JSON (debug/agent curation input). */
  cacheFile: z.string().default('/home/zzw/work/news/.cache/candidates.json'),
  /** Collection lookback window in hours. */
  ageHours: z.number().step(1).min(6).max(240).default(72),
  /** Candidate cap passed to curation (top-N by score). */
  maxItems: z.number().step(1).min(10).max(400).default(120),
  /** IANA zone for the digest date. */
  timezone: z.string().default('Asia/Shanghai'),
  /** Curation LLM route; empty = the deployment default (agentDefaultModel). */
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  /**
   * Output token budget for the curation call. Thinking models spend most of
   * it on reasoning before the JSON, so this must exceed the plain-model
   * estimate (a 4K budget truncates a 27B thinking model's curation output).
   */
  curationMaxTokens: z.number().step(1).min(1024).max(131072).default(16384),
  /**
   * Reasoning effort for the curation call. Curation is a mechanical
   * extract-and-summarize job: at a deployment's default (e.g. xhigh)
   * thinking models can spend the entire output budget reasoning and
   * finish max-tokens with zero JSON. 'off' keeps the budget for the
   * answer; empty string = do not override (use the deployment default).
   */
  curationReasoningEffort: z.string().default('off'),
  /** Slash command name (without the leading slash). */
  commandName: z.string().default('news'),
  /** Cooperative timeout budget for news_digest / the generate endpoint. */
  generateTimeoutMs: z.number().step(1).min(60000).default(600000),
})

const MAX_CANDIDATES_TO_CURATE = 60

function extractHeadlines(markdown, limit = 3) {
  const out = []
  const lines = String(markdown || '').split('\n')
  let inHeadlines = false
  for (const line of lines) {
    if (line.includes('**今日要点**')) { inHeadlines = true; continue }
    if (!inHeadlines) continue
    if (line.startsWith('---')) break
    const m = line.match(/^>\s*\d+\.\s*\*\*(.+?)\*\*/)
    if (m && m[1]) out.push(m[1].trim())
    if (out.length >= limit) break
  }
  return out
}

export async function apply(ctx, config) {
  const outputDir = path.resolve(config.outputDir)
  const stateFile = path.resolve(config.stateFile)
  const cacheFile = path.resolve(config.cacheFile)
  mkdirSync(outputDir, { recursive: true })
  mkdirSync(path.dirname(cacheFile), { recursive: true })

  function llmRoute() {
    const adm = ctx.get('agentDefaultModel')
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
    const route = {
      provider: config.llmProvider || (sel && sel.provider) || 'deepseek-official',
      model: config.llmModel || (sel && sel.model) || 'deepseek-v4-flash',
    }
    if (config.curationReasoningEffort) route.reasoningEffort = config.curationReasoningEffort
    return route
  }
  const stream = (opts) => ctx.llm.stream({ ...llmRoute(), ...opts })

  const FULL_MAX_ITEMS = 500

  // One pipeline at a time per process (the GUI button and a concurrent
  // /news must not write the same day's file twice).
  let generating = false

  /**
   * Optional web-search augmentation — collection parity with the skill's
   * 热点补充 step (the query set is shared: SKILL.md step 2 and this list
   * stay in sync): the two baseline queries plus one targeted follow-up
   * derived from the pool's top release (the skill's agent does the same
   * manually). The 39 deterministic sources miss Chinese media, community
   * PRs and vendor posts that only search surfaces. Capped at 15 scored
   * items; a search failure degrades to a footer entry, never aborts.
   */
  async function webAugment({ signal, pool } = {}) {
    const web = ctx.get('web')
    const t0 = Date.now()
    if (!web || typeof web.search !== 'function') {
      return { items: [], source: { name: 'WebSearch', status: 'skipped', error: 'web 服务不可用', ms: Date.now() - t0 } }
    }
    try {
      const queries = ['大模型推理 最新进展', 'LLM inference engine release']
      const topRelease = (pool || []).find((it) => it.kind === 'release' && (it.score || 0) >= 3)
      if (topRelease) {
        const project = String(topRelease.source || '').replace(/^GitHub:/, '').split('/')[1] || topRelease.source
        const tag = topRelease.tag ? ' ' + topRelease.tag : ''
        queries.push(project + tag + ' release 报道 评测')
      }
      const raw = []
      const keys = new Set()
      for (const q of queries) {
        const r = await web.search({ query: q, maxResults: 10 }, signal)
        for (const s of r.sources || []) {
          const key = normUrl(s.url)
          if (!key || keys.has(key)) continue
          keys.add(key)
          raw.push({
            kind: 'blog',
            source: 'WebSearch',
            title: s.title || s.url,
            url: s.url,
            snippet: String(s.snippet || '').slice(0, 400),
            publishedAt: s.publishedAt || new Date().toISOString(),
          })
        }
      }
      const items = raw
        .map((it) => { const { score, matched } = scoreItem([it.title, it.snippet].join(' ')); return { ...it, score, matched } })
        .filter((it) => it.score >= 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15)
      return { items, source: { name: 'WebSearch', status: 'ok', fetched: items.length, ms: Date.now() - t0 } }
    } catch (err) {
      return { items: [], source: { name: 'WebSearch', status: 'error', error: String((err && err.message) || err), ms: Date.now() - t0 } }
    }
  }

  /** Merge web-search items into a collected result (dedupe by normalized URL). */
  function mergeWeb(collected, web) {
    const items = collected.items || []
    const keys = new Set(items.map((it) => normUrl(it.url)))
    for (const it of web.items) {
      const key = normUrl(it.url)
      if (keys.has(key)) continue
      keys.add(key)
      items.push(it)
    }
    items.sort((a, b) => b.score - a.score || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    collected.items = items
    collected.sources = [...(collected.sources || []), web.source]
    collected.itemCount = items.length
    return items
  }

  /**
   * Hours elapsed since local midnight in the configured zone (the "today"
   * window). Wall-clock arithmetic, no epoch inversion: format now in the
   * zone and read H:M:S.
   */
  function hoursSinceMidnight(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now)
    const g = (type) => Number(parts.find((x) => x.type === type).value)
    return (g('hour') % 24) + g('minute') / 60 + g('second') / 3600
  }

  /**
   * The digest pipeline. Both modes collect the window in full — the seen
   * history is NEVER used to filter candidates.
   * @param mode 'daily' (default): the window is TODAY (local midnight ->
   *   now); writes digests/YYYY-MM-DD.md (same-day rerun overwrites with the
   *   fuller set) and appends the final URLs to the seen history log.
   *   'full': the caller's window (ageHours, default the configured
   *   lookback); archives to a UNIQUE file digests/<date>_full-<H>h-<HHMMSS>.md
   *   (views never clobber each other or the day's report), returns the
   *   markdown, and leaves the seen log untouched.
   * @param ageHours full-mode window override.
   */
  async function runDigest({ signal, mode = 'daily', ageHours } = {}) {
    if (generating) throw new Error('日报正在生成中，请稍候再试')
    generating = true
    try {
      const full = mode === 'full'
      const date = digestDate(config.timezone)
      // daily = today only (midnight -> now); full = the caller's window.
      const hours = full
        ? (Number(ageHours) > 0 ? Number(ageHours) : config.ageHours)
        : hoursSinceMidnight()
      const collected = await runCollect({
        out: cacheFile,
        ageHours: hours,
        state: '',
        maxItems: full ? FULL_MAX_ITEMS : config.maxItems,
      })
      mergeWeb(collected, await webAugment({ signal, pool: collected.items }))
      const items = collected.items || []
      if (!items.length) throw new Error('未采集到任何候选条目（各源状态见 .cache/candidates.json）')
      const data = await curateItems(items.slice(0, MAX_CANDIDATES_TO_CURATE), { stream, signal, maxTokens: config.curationMaxTokens })
      const scope = full ? '全量视图 · 近 ' + Math.round(hours) + ' 小时' : ''
      const markdown = renderDigest({ date, config, data, collected, scope })
      // daily: the canonical day file; full: a uniquely-named archive file.
      const stem = full ? fullViewName(date, hours, new Date(), config.timezone) : date
      const file = writeDigest({ outputDir, date: stem, markdown })
      if (!full) recordSeen({ updateSeen: file, state: stateFile }) // history log only; never filters
      return {
        date,
        file: stem,
        path: file,
        scope,
        markdown,
        mode: full ? 'full' : 'daily',
        headlines: (data.headlines || []).map((h) => h.title).slice(0, 3),
        itemCount: items.length,
        sources: collected.sources || [],
      }
    } finally {
      generating = false
    }
  }

  // ── model tools ────────────────────────────────────────────────────────────
  const textOut = {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, text: { type: 'string' } } },
    render: (_a, v) => [{ type: 'text', text: (v && v.text) || '' }],
  }

  const newsCollect = defineTool({
    name: 'news_collect',
    description: '按时间窗全量采集大模型推理候选资讯（arXiv / HF Daily Papers / 开源引擎 GitHub releases，含 vLLM-Ascend 与华为昇腾系 MindIE/MindSpeed/torch_npu / 技术博客 / Hacker News / web 搜索补充；不做历史去重），返回按推理关键词打分的候选列表与各源状态。只读，零 LLM 成本；想深挖时用返回的候选自行筛选。',
    parameters: {
      ageHours: { type: 'integer', description: '时间窗（小时），6–336；缺省用插件配置（默认 72）' },
    },
    output: textOut,
    async execute(args, exec) {
      const hours = Number(args && args.ageHours) > 0 ? Number(args.ageHours) : config.ageHours
      const c = await runCollect({ out: cacheFile, ageHours: hours, state: '', maxItems: config.maxItems })
      mergeWeb(c, await webAugment({ signal: exec.signal, pool: c.items }))
      const src = (c.sources || []).map((s) => (s.status === 'ok' ? '✅ ' : '❌ ') + s.name + (s.status === 'ok' ? ' (' + s.fetched + ' 条)' : ' ' + (s.error || ''))).join('\n')
      const top = JSON.stringify((c.items || []).slice(0, 40), null, 1)
      return { ok: true, text: '共 ' + c.itemCount + ' 条候选（近 ' + hours + ' 小时）\n\n各源状态：\n' + src + '\n\n候选列表（前 40，JSON）：\n' + top }
    },
    timeoutMs: 420000,
  })

  const newsDigest = defineTool({
    name: 'news_digest',
    description: '生成大模型推理日报（均不做历史去重）。mode=daily（默认）：采集【当天 00:00 至现在】的全量条目 → LLM 筛选 → 覆盖写入 digests/YYYY-MM-DD.md（当天重复调用只增不减）并记录 seen 历史。mode=full：按 ageHours 时间窗（6–336，建议 24/48/72/168）全量采集 → LLM 筛选 → 存档到唯一文件名 digests/<日期>_full-<窗>h-<时刻>.md（互不覆盖、不更新 seen）并返回 Markdown（适合“看看最近 N 小时/天推理圈全部动静”）。耗时数分钟。',
    parameters: {
      mode: { type: 'string', enum: ['daily', 'full'], description: "'daily'（默认）或 'full'（全量视图：不去重、不落盘、返回 markdown）" },
      ageHours: { type: 'integer', description: '仅 full 模式有效的时间窗（小时），6–336，建议 24/48/72/168；daily 模式忽略此参数（固定用插件配置的时间窗）' },
    },
    output: textOut,
    async execute(args, exec) {
      const r = await runDigest({ signal: exec.signal, mode: args && args.mode === 'full' ? 'full' : 'daily', ageHours: args && args.ageHours })
      if (r.mode === 'full') {
        return {
          ok: true,
          text: '全量视图已生成（' + r.scope + '，候选 ' + r.itemCount + ' 条；存档 ' + r.path + '，未更新 seen 历史）：\n\n' + r.markdown,
        }
      }
      return {
        ok: true,
        text: '日报已生成：' + r.path + '\n候选 ' + r.itemCount + ' 条。头条：\n' + r.headlines.map((h, i) => (i + 1) + '. ' + h).join('\n'),
      }
    },
    timeoutMs: config.generateTimeoutMs,
  })

  const toolDisposers = [ctx.tools.register(newsCollect), ctx.tools.register(newsDigest)]

  // ── human command /news ────────────────────────────────────────────────────
  const commandDisposer = ctx.commands.register({
    name: config.commandName,
    description: '生成今日大模型推理日报（采集 → 筛选 → 写日报 → 更新状态），耗时数分钟；完成后右侧边栏「📰 日报」可查看全文',
    handler: async (invocation) => {
      try {
        const r = await runDigest({ signal: invocation.signal })
        return {
          kind: 'success',
          text: '📰 ' + r.date + ' 日报已生成（候选 ' + r.itemCount + ' 条）\n' + r.headlines.map((h, i) => (i + 1) + '. ' + h).join('\n') + '\n文件：' + r.path,
        }
      } catch (err) {
        return { kind: 'error', text: '日报生成失败：' + String((err && err.message) || err) }
      }
    },
  })

  // ── webServer JSON routes (web profile only) ───────────────────────────────
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
    // File stems: daily reports 'YYYY-MM-DD', full-view archives
    // 'YYYY-MM-DD_full-<H>h-<HHMMSS>'.
    const STEM_RE = /^(\d{4}-\d{2}-\d{2})(?:_full-(\d+)h-(\d{6}))?$/
    const listDigests = () => {
      if (!existsSync(outputDir)) return []
      return readdirSync(outputDir)
        .map((f) => {
          const m = f.match(/^(.+)\.md$/)
          if (!m || !STEM_RE.test(m[1])) return null
          return { stem: m[1], file: f }
        })
        .filter(Boolean)
        .map(({ stem, file }) => {
          const st = statSync(path.join(outputDir, file))
          const md = readFileSync(path.join(outputDir, file), 'utf8')
          const m = stem.match(STEM_RE)
          return {
            name: stem,
            date: m[1],
            kind: m[2] ? 'full' : 'daily',
            ...(m[2] ? { windowHours: Number(m[2]), at: m[3] } : {}),
            size: st.size,
            mtime: st.mtimeMs,
            headlines: extractHeadlines(md),
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
    }
    const route = {
      kind: 'prefix',
      path: '/inference-news',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost')
          const seg = url.pathname.replace(/^\/inference-news\/?/, '').split('/').filter(Boolean)
          if (req.method === 'GET' && seg[0] === 'digests' && seg.length === 1) {
            return sendJson(res, 200, { ok: true, digests: listDigests() })
          }
          if (req.method === 'GET' && seg[0] === 'digests' && seg.length === 2 && STEM_RE.test(seg[1])) {
            const file = path.join(outputDir, seg[1] + '.md')
            if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '该日报不存在' })
            const md = readFileSync(file, 'utf8')
            const m = seg[1].match(STEM_RE)
            return sendJson(res, 200, { ok: true, name: seg[1], date: m[1], kind: m[2] ? 'full' : 'daily', markdown: md, headlines: extractHeadlines(md) })
          }
          if (req.method === 'POST' && seg[0] === 'generate' && seg.length === 1) {
            const body = JSON.parse((await readBody(req)) || '{}')
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), config.generateTimeoutMs)
            try {
              const r = await runDigest({ signal: ac.signal, mode: body.mode === 'full' ? 'full' : 'daily', ageHours: body.ageHours })
              return sendJson(res, 200, { ok: true, date: r.date, name: r.file, scope: r.scope, mode: r.mode, path: r.path, markdown: r.markdown, headlines: r.headlines, itemCount: r.itemCount, sources: r.sources })
            } finally {
              clearTimeout(timer)
            }
          }
          return sendJson(res, 404, { ok: false, error: 'unknown inference-news route' })
        } catch (err) {
          const msg = String((err && err.message) || err)
          return sendJson(res, err && err.message === '日报正在生成中，请稍候再试' ? 409 : 500, { ok: false, error: msg })
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
  }, 'dsh-inference-news.dispose')
}
