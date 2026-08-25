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
import { runCollect, recordSeen } from './collect.js'
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
    return {
      provider: config.llmProvider || (sel && sel.provider) || 'deepseek-official',
      model: config.llmModel || (sel && sel.model) || 'deepseek-v4-flash',
    }
  }
  const stream = (opts) => ctx.llm.stream({ ...llmRoute(), ...opts })

  // One pipeline at a time per process (the GUI button and a concurrent
  // /news must not write the same day's file twice).
  let generating = false

  async function runDigest({ signal } = {}) {
    if (generating) throw new Error('日报正在生成中，请稍候再试')
    generating = true
    try {
      const date = digestDate(config.timezone)
      const collected = await runCollect({ out: cacheFile, ageHours: config.ageHours, state: stateFile, maxItems: config.maxItems })
      const items = collected.items || []
      if (!items.length) throw new Error('未采集到任何候选条目（各源状态见 .cache/candidates.json）')
      const data = await curateItems(items.slice(0, MAX_CANDIDATES_TO_CURATE), { stream, signal })
      const markdown = renderDigest({ date, config, data, collected })
      const file = writeDigest({ outputDir, date, markdown })
      recordSeen({ updateSeen: file, state: stateFile })
      return {
        date,
        path: file,
        markdown,
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
    description: '采集近 N 小时的大模型推理候选资讯（arXiv / HF Daily Papers / 开源引擎 GitHub releases，含 vLLM-Ascend 与华为昇腾系 MindIE/MindSpeed/torch_npu / 技术博客 / Hacker News），返回按推理关键词打分的候选列表与各源状态。只读，零 LLM 成本；想深挖时用返回的候选自行筛选。',
    parameters: {},
    output: textOut,
    async execute(_args, exec) {
      const c = await runCollect({ out: cacheFile, ageHours: config.ageHours, state: stateFile, maxItems: config.maxItems })
      const src = (c.sources || []).map((s) => (s.status === 'ok' ? '✅ ' : '❌ ') + s.name + (s.status === 'ok' ? ' (' + s.fetched + ' 条)' : ' ' + (s.error || ''))).join('\n')
      const top = JSON.stringify((c.items || []).slice(0, 40), null, 1)
      return { ok: true, text: '共 ' + c.itemCount + ' 条候选\n\n各源状态：\n' + src + '\n\n候选列表（前 40，JSON）：\n' + top }
    },
    timeoutMs: 420000,
  })

  const newsDigest = defineTool({
    name: 'news_digest',
    description: '生成今日大模型推理日报：采集 → LLM 筛选 → 写入 digests/YYYY-MM-DD.md → 更新去重状态。耗时数分钟；同一天重复调用会覆盖当天日报。需要用户要求生成日报/新闻日报时使用。',
    parameters: {},
    output: textOut,
    async execute(_args, exec) {
      const r = await runDigest({ signal: exec.signal })
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
  let routeDisposers = []
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
            const ac = new AbortController()
            const timer = setTimeout(() => ac.abort(), config.generateTimeoutMs)
            try {
              const r = await runDigest({ signal: ac.signal })
              return sendJson(res, 200, { ok: true, date: r.date, path: r.path, headlines: r.headlines, itemCount: r.itemCount })
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
    routeDisposers = [webServer.register(route)]
  }

  ctx.effect(() => {
    toolDisposers.forEach((d) => { try { d() } catch {} })
    if (commandDisposer) { try { commandDisposer() } catch {} }
    routeDisposers.forEach((d) => { try { d() } catch {} })
  }, 'dsh-inference-news.dispose')
}
