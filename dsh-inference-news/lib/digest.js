// dsh-inference-news — digest curation (auxiliary LLM call) and deterministic
// markdown rendering.
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Today's YYYY-MM-DD in the configured zone. */
export function digestDate(timezone = 'Asia/Shanghai', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Header date line, e.g. "2026年8月25日 星期二". */
export function headerDate(dateStr, timezone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date(dateStr + 'T00:00:00Z'))
}

const PROMPT_LINES = [
  '你是一名大模型推理（LLM inference）方向的日报编辑。下面给你一批候选条目（已按相关度降序打分），每行格式：',
  '序号. [类型] 标题 | 链接 | 元数据 | 摘要',
  '类型：paper（arXiv/HF 论文）、release（开源项目发布）、blog（技术博客）、community（社区讨论）。',
  '',
  '请输出如下结构的 JSON（只输出 JSON，不要任何其他文字、不要代码块围栏）：',
  '{',
  '  "headlines": [{"title": "…", "why": "1–2 句为什么重要（可含关键数字与背景）", "links": ["url", "…"]}],',
  '  "releases": [{"repo": "项目名", "version": "版本号", "date": "MM-DD", "link": "url", "bullets": ["中文变更点（3–8 条，含性能数字/影响面）", "…"]}],',
  '  "papers": [{"title": "论文标题（保留原文）", "link": "url", "category": "cs.xx 或 —", "note": "中文点评（60–100 字：方法要点 / 关键结果 / 对推理部署的意义，基于摘要）"}],',
  '  "community": [{"title": "标题", "link": "url", "stats": "▲ 分数 / N 评论", "note": "中文说明（60–100 字：为什么值得关注，可含背景）"}],',
  '  "note": "可选：数据来源状态或特殊情况说明"',
  '}',
  '',
  '规则：',
  '1. headlines 必须恰好 3 条，从全量候选里挑最重要的（重大 release / 高影响力论文 / 热议事件）。',
  '2. releases：只保留窗口内有实质变更的 release，按项目分组（每个项目一条，bullets 3–8 条列具体变更与数字）；没有就空数组。',
  '3. papers：5–12 篇，优先分数高且重要的，宁缺毋滥；没有就空数组。',
  '4. community：3–5 条；没有就空数组。',
  '5. 所有 title 与 link 必须取自候选条目，URL 逐字复制候选中的链接，严禁编造 URL 或内容。',
  '6. 点评与变更点必须基于摘要内容；摘要为空或明显与推理无关的条目应排除。',
  '7. 正文用中文（论文标题保留英文原文）。',
]
export const CURATION_SYSTEM = PROMPT_LINES.join('\n')

function metaOf(it) {
  if (it.kind === 'release') return it.tag || ''
  if (it.kind === 'community') return '▲ ' + (it.points || 0) + ' / ' + (it.comments || 0) + ' 评论'
  if (it.kind === 'paper') {
    const parts = []
    if (it.category) parts.push(it.category)
    if (it.upvotes) parts.push('⬆' + it.upvotes)
    return parts.join(' · ')
  }
  return (it.publishedAt || '').slice(0, 10)
}

/** Compact numbered candidate list for the curation prompt. */
export function buildCurationPayload(items) {
  return items.map((it, i) => {
    const meta = metaOf(it)
    const snip = (it.snippet || '').replace(/\s+/g, ' ').slice(0, 200)
    const line = (i + 1) + '. [' + it.kind + '] ' + (it.title || '').replace(/\s+/g, ' ') + ' | ' + it.url
    return line + (meta ? ' | ' + meta : '') + (snip ? ' | ' + snip : '')
  }).join('\n')
}

/** Tolerant JSON extraction: code fences, leading prose, trailing junk. */
export function parseCuration(text) {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('LLM 输出中未找到 JSON 对象')
  const data = JSON.parse(t.slice(a, b + 1))
  for (const k of ['headlines', 'releases', 'papers', 'community']) {
    if (!Array.isArray(data[k])) throw new Error('LLM 输出缺少数组字段: ' + k)
  }
  data.note = typeof data.note === 'string' ? data.note : ''
  return data
}

/**
 * One auxiliary LLM call over the candidate list.
 * @param items ranked candidates (already sliced by the caller).
 * @param stream (options) => AsyncIterable<StreamChunk> — ctx.llm.stream with provider/model pre-bound.
 * @param signal AbortSignal.
 */
/**
 * One user Message in the exact dsh-llm shape (message.ts): branded string
 * id, ContentBlock[] content, { kind: 'user' } source. Built by hand (not
 * createUserMessage) so this module stays dependency-free for the unit runner;
 * the two are structurally identical at runtime.
 */
function curationMessage(userText) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }
}

export async function curateItems(items, { stream, signal, maxTokens = 16384 }) {
  const user = '候选条目（共 ' + items.length + ' 条，按相关度降序）：\n\n' + buildCurationPayload(items) + '\n\n请严格按系统要求输出 JSON。'
  let text = ''
  let finish = null
  for await (const chunk of stream({
    system: CURATION_SYSTEM,
    messages: [curationMessage(user)],
    temperature: 0,
    maxTokens,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  // Adapter failures arrive as a terminal finish chunk, not a throw (the
  // stream protocol normalizes them) — surface the real failure instead of
  // misreading it as empty model output.
  if (finish && finish.kind === 'error') {
    const f = finish.failure || {}
    throw new Error('LLM 筛选调用失败：' + (f.message || f.code || JSON.stringify(f)))
  }
  if (finish && finish.kind === 'aborted') throw new Error('LLM 筛选调用被中止')
  if (finish && finish.kind === 'max-tokens') {
    throw new Error(
      text.trim()
        ? 'LLM 筛选输出达到 max-tokens 上限且 JSON 不完整：调大 curationMaxTokens，或降低 curationReasoningEffort（如 off）让输出预算留给正文'
        : 'LLM 筛选调用未返回内容：推理 token 耗尽了全部输出预算（finish: max-tokens）。请设置 curationReasoningEffort: off（或更小），或调大 curationMaxTokens',
    )
  }
  if (!text.trim()) throw new Error('LLM 筛选调用未返回内容（finish: ' + JSON.stringify(finish) + '）')
  return parseCuration(text)
}

function mdEscapeCell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * Deterministic digest markdown from curated data + collection stats.
 * @param scope optional view label appended to the title (e.g. a full-window
 *   view); when set, a footer note explains the view is display-only
 *   (no historical dedup, not written to disk, seen state untouched).
 */
export function renderDigest({ date, config, data, collected, scope }) {
  const L = []
  L.push('# 📰 大模型推理日报 · ' + headerDate(date, config.timezone) + (scope ? ' · ' + scope : ''))
  L.push('')
  const hostOf = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, '') } catch { return '链接' } }
  const hl = (data.headlines || []).slice(0, 3)
  if (hl.length) {
    L.push('> **今日要点**')
    L.push('>')
    for (let i = 0; i < hl.length; i++) {
      const h = hl[i]
      const links = (h.links || []).slice(0, 3).map((u) => '[' + hostOf(u) + '](' + u + ')')
      const linkTxt = links.length ? '（' + links.join(' / ') + '）' : ''
      L.push('> ' + (i + 1) + '. **' + h.title + '**' + (h.why ? ' — ' + h.why : '') + linkTxt)
    }
  } else {
    L.push('> **今日要点**：今日资讯较少，暂无突出要点。')
  }
  L.push('')
  L.push('---')
  L.push('')

  L.push('## 🚀 引擎与开源动态')
  L.push('')
  if (!(data.releases || []).length) {
    L.push('今日无重大 release。')
    L.push('')
  } else {
    for (const r of data.releases) {
      L.push('### ' + r.repo)
      L.push('- **' + (r.version || '—') + '**' + (r.date ? ' · ' + r.date : '') + ' · [Release](' + r.link + ')')
      for (const b of r.bullets || []) L.push('  - ' + b)
      L.push('')
    }
  }

  L.push('## 📄 新论文')
  L.push('')
  if (!(data.papers || []).length) {
    L.push('窗口内无入选论文。')
    L.push('')
  } else {
    L.push('| 论文 | 分类 | 一句话点评 |')
    L.push('| --- | --- | --- |')
    for (const p of data.papers) {
      L.push('| [' + mdEscapeCell(p.title) + '](' + p.link + ') | ' + mdEscapeCell(p.category || '—') + ' | ' + mdEscapeCell(p.note) + ' |')
    }
    L.push('')
  }

  L.push('## 🔥 社区热点')
  L.push('')
  if (!(data.community || []).length) {
    L.push('今日无入选社区热点。')
    L.push('')
  } else {
    for (const c of data.community) {
      L.push('- [' + c.title + '](' + c.link + ')' + (c.stats ? ' · ' + c.stats : '') + ' — ' + (c.note || ''))
    }
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('<details>')
  L.push('<summary>📋 数据来源（点击展开）</summary>')
  L.push('')
  L.push('| 源 | 状态 | 获取 → 入选 |')
  L.push('| --- | --- | --- |')
  const src = (name) => (collected.sources || []).find((s) => s.name === name)
  const gh = (collected.sources || []).filter((s) => s.name.startsWith('GitHub:'))
  const hn = (collected.sources || []).filter((s) => s.name.startsWith('HackerNews:'))
  const blogs = (collected.sources || []).filter((s) => !s.name.startsWith('GitHub:') && !s.name.startsWith('HackerNews:') && s.name !== 'arXiv' && s.name !== 'HF Daily Papers')
  const arx = src('arXiv')
  const hf = src('HF Daily Papers')
  const ghOk = gh.filter((s) => s.status === 'ok').length
  const hnOk = hn.filter((s) => s.status === 'ok').length
  const arxivPapers = (data.papers || []).filter((p) => (p.link || '').includes('arxiv.org')).length
  L.push('| arXiv + HF Daily Papers | ' + (arx && arx.status === 'ok' ? '✅' : '❌') + ' | ' + (arx ? arx.fetched : 0) + ' + ' + (hf ? hf.fetched : 0) + ' → ' + arxivPapers + ' |')
  L.push('| GitHub Releases | ' + (gh.length ? (ghOk === gh.length ? '✅ ' : '⚠️ ') + ghOk + '/' + gh.length : '—') + ' | ' + gh.reduce((n, s) => n + (s.fetched || 0), 0) + ' → ' + (data.releases || []).length + ' |')
  L.push('| 技术博客 | ' + (blogs.length ? '✅' : '—') + ' | ' + blogs.reduce((n, s) => n + (s.fetched || 0), 0) + ' → 见正文 |')
  L.push('| Hacker News | ' + (hn.length ? (hnOk === hn.length ? '✅ ' : '⚠️ ') + hnOk + '/' + hn.length : '—') + ' | ' + hn.reduce((n, s) => n + (s.fetched || 0), 0) + ' → ' + (data.community || []).length + ' |')
  if (data.note) {
    L.push('')
    L.push('备注：' + data.note)
  }
  if (scope) {
    L.push('')
    L.push('备注：' + scope + '——不做历史去重，仅呈现时间窗内入选条目；本视图不落盘、不更新去重状态。')
  }
  L.push('')
  L.push('</details>')
  L.push('')
  return L.join('\n')
}

/** Write digests/YYYY-MM-DD.md (same-day rerun overwrites). */
export function writeDigest({ outputDir, date, markdown }) {
  mkdirSync(outputDir, { recursive: true })
  const file = path.join(outputDir, date + '.md')
  writeFileSync(file, markdown)
  return file
}
