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
import { curateItems, renderDigest, writeDigest, digestDate } from './digest.js'

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
   * Optional web-search augmentation (parity with the M0 skill's 热点补充
   * step): the 39 deterministic sources miss Chinese media, community PRs
   * and vendor posts that only search surfaces. Two queries, capped at 10
   * scored items; a search failure degrades to a footer entry, never aborts.
   */
  async function webAugment({ signal } = {}) {
    const web = ctx.get('web')
    const t0 = Date.now()
    if (!web || typeof web.search !== 'function') {
      return { items: [], source: { name: 'WebSearch', status: 'skipped', error: 'web 服务不可用', ms: Date.now() - t0 } }
    }
    try {
      const queries = ['大模型推理 最新 进展 发布', 'LLM inference engine release']
      const raw = []
      const keys = new Set()
      for (const q of queries) {
        const r = await web.search({ query: q, maxResults: 8 }, signal)
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
        .slice(0, 10)
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
   * The digest pipeline.
   * @param mode 'daily' (default): seen-dedup, same-day union (URLs already in
   *   today's digest re-enter the pool), writes digests/YYYY-MM-DD.md and
   *   updates seen state. 'full': a display-only window view — no seen
   *   dedup at all, no file write, no seen update; the markdown comes back
   *   to the caller (sidebar tab / tool result).
   * @param ageHours window override (full mode takes the user's choice).
   */
  async function runDigest({ signal, mode = 'daily', ageHours } = {}) {
    if (generating) throw new Error('日报正在生成中，请稍候再试')
    generating = true
    try {
      const full = mode === 'full'
      const date = digestDate(config.timezone)
      const hours = Number(ageHours) > 0 ? Number(ageHours) : config.ageHours
      let reincludeUrls = []
      if (!full) {
        const existing = path.join(outputDir, date + '.md')
        if (existsSync(existing)) {
          reincludeUrls = [...readFileSync(existing, 'utf8').matchAll(/https?:\/\/[^)\]\s>"'，。、；]+/g)].map((m) => m[0])
        }
      }
      const collected = await runCollect({
        out: cacheFile,
        ageHours: hours,
        state: full ? '' : stateFile,
        maxItems: full ? FULL_MAX_ITEMS : config.maxItems,
        reincludeUrls,
      })
      mergeWeb(collected, await webAugment({ signal }))
      const items = collected.items || []
      if (!items.length) throw new Error('未采集到任何候选条目（各源状态见 .cache/candidates.json）')
      const data = await curateItems(items.slice(0, MAX_CANDIDATES_TO_CURATE), { stream, signal, maxTokens: config.curationMaxTokens })
      const scope = full ? '全量视图 · 近 ' + hours + ' 小时' : ''
      const markdown = renderDigest({ date, config, data, collected, scope })
      const result = {
        date,
        scope,
        markdown,
        mode: full ? 'full' : 'daily',
        headlines: (data.headlines || []).map((h) => h.title).slice(0, 3),
        itemCount: items.length,
        sources: collected.sources || [],
      }
      if (full) return result
      const file = writeDigest({ outputDir, date, markdown })
      recordSeen({ updateSeen: file, state: stateFile })
      result.path = file
      return result
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
    description: '采集近 N 小时的大模型推理候选资讯（arXiv / HF Daily Papers / 开源引擎 GitHub releases，含 vLLM-Ascend 与华为昇腾系 MindIE/MindSpeed/torch_npu / 技术博客 / Hacker News / web 搜索补充），返回按推理关键词打分的候选列表与各源状态。只读，零 LLM 成本；想深挖时用返回的候选自行筛选。',
    parameters: {
      ageHours: { type: 'integer', description: '时间窗（小时），6–336；缺省用插件配置（默认 72）' },
    },
    output: textOut,
    async execute(args, exec) {
      const hours = Number(args && args.ageHours) > 0 ? Number(args.ageHours) : config.ageHours
      const c = await runCollect({ out: cacheFile, ageHours: hours, state: stateFile, maxItems: config.maxItems })
      mergeWeb(c, await webAugment({ signal: exec.signal }))
      const src = (c.sources || []).map((s) => (s.status === 'ok' ? '✅ ' : '❌ ') + s.name + (s.status === 'ok' ? ' (' + s.fetched + ' 条)' : ' ' + (s.error || ''))).join('\n')
      const top = JSON.stringify((c.items || []).slice(0, 40), null, 1)
      return { ok: true, text: '共 ' + c.itemCount + ' 条候选（近 ' + hours + ' 小时）\n\n各源状态：\n' + src + '\n\n候选列表（前 40，JSON）：\n' + top }
    },
    timeoutMs: 420000,
  })

  const newsDigest = defineTool({
    name: 'news_digest',
    description: '生成大模型推理日报。mode=daily（默认）：采集（去重 + 同日并集）→ LLM 筛选 → 写入 digests/YYYY-MM-DD.md → 更新去重状态，同一天重复调用会合并覆盖当天日报。mode=full：按 ageHours 时间窗全量采集（完全不做历史去重）→ LLM 筛选 → 直接返回 Markdown，不落盘、不更新去重状态（适合“看看最近 N 小时/天推理圈全部动静”这类请求）。耗时数分钟。',
    parameters: {
      mode: { type: 'string', enum: ['daily', 'full'], description: "'daily'（默认）或 'full'（全量视图：不去重、不落盘、返回 markdown）" },
      ageHours: { type: 'integer', description: '时间窗（小时），6–336；full 模式建议 24/48/72/168；daily 模式缺省用插件配置' },
    },
    output: textOut,
    async execute(args, exec) {
      const r = await runDigest({ signal: exec.signal, mode: args && args.mode === 'full' ? 'full' : 'daily', ageHours: args && args.ageHours })
      if (r.mode === 'full') {
        return {
          ok: true,
          text: '全量视图（' + r.scope + '，候选 ' + r.itemCount + ' 条；未落盘、未更新去重状态）：\n\n' + r.markdown,
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
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
    const listDigests = () => {
      if (!existsSync(outputDir)) return []
      return readdirSync(outputDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .map((f) => {
          const st = statSync(path.join(outputDir, f))
          const md = readFileSync(path.join(outputDir, f), 'utf8')
          return { date: f.slice(0, 10), size: st.size, mtime: st.mtimeMs, headlines: extractHeadlines(md) }
        })
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
          if (req.method === 'GET' && seg[0] === 'digests' && seg.length === 2 && DATE_RE.test(seg[1])) {
            const file = path.join(outputDir, seg[1] + '.md')
            if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '该日期暂无日报' })
            const md = readFileSync(file, 'utf8')
            return sendJson(res, 200, { ok: true, date: seg[1], markdown: md, headlines: extractHeadlines(md) })
          }
          if (req.method === 'POST' && seg[0] === 'generate' && seg.length === 1) {
            const body = JSON.parse((await readBody(req)) || '{}')
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), config.generateTimeoutMs)
            try {
              const r = await runDigest({ signal: ac.signal, mode: body.mode === 'full' ? 'full' : 'daily', ageHours: body.ageHours })
              const out = { ok: true, date: r.date, scope: r.scope, mode: r.mode, headlines: r.headlines, itemCount: r.itemCount, sources: r.sources }
              if (r.mode === 'full') out.markdown = r.markdown
              else out.path = r.path
              return sendJson(res, 200, out)
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
