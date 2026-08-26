// dsh-wx-daily — LLM summary (one auxiliary call) and deterministic markdown
// rendering for the 公众号 panel.
import { randomUUID } from 'node:crypto'

const SYSTEM_PROMPT_LINES = [
  '你是一名微信公众号内容编辑。用户关注一批 AI / 技术 / 创业方向的公众号，下面是本次时间窗内采集到的文章列表，每行格式：',
  '序号. [公众号名] 发布时刻 标题 | 链接 | 摘要',
  '',
  '请输出如下结构的 JSON（只输出 JSON，不要任何其他文字、不要代码块围栏）：',
  '{',
  '  "overview": "一句话整体速览（40 字内：共几个号有更新、热点集中在哪）",',
  '  "picks": [',
  '    {"title": "文章标题（逐字取自候选）", "url": "文章链接（逐字取自候选）", "account": "公众号名", "note": "一句话点评（30 字内，为什么值得看，基于摘要，不确定的背景不编造）"}',
  '  ]',
  '}',
  '',
  '规则：',
  '1. picks 挑 3–10 条最值得一读的，按价值降序；全部条目都不值得看时给空数组并在 overview 里说明。',
  '2. title / url / account 必须逐字取自候选条目，严禁编造 URL、标题或公众号名。',
  '3. 摘要为空时只按标题判断，note 写保守。',
  '4. 用中文。',
]
export const SUMMARY_SYSTEM = SYSTEM_PROMPT_LINES.join('\n')

/** Compact numbered candidate list for the summary prompt. */
export function buildSummaryPayload(items) {
  return (items || []).map((it, i) => {
    const when = it.publishedAt ? it.publishedAt.slice(5, 16).replace('T', ' ') : '—'
    const snip = String(it.summary || '').replace(/\s+/g, ' ').slice(0, 200)
    const line = (i + 1) + '. [' + (it.account || '未知') + '] ' + when + ' ' + String(it.title || '').replace(/\s+/g, ' ') + ' | ' + it.url
    return snip ? line + ' | ' + snip : line
  }).join('\n')
}

/** Tolerant JSON extraction: code fences, leading prose, trailing junk. */
export function parseSummary(text) {
  let t = String(text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('LLM 输出中未找到 JSON 对象')
  const data = JSON.parse(t.slice(a, b + 1))
  if (typeof data.overview !== 'string') throw new Error('LLM 输出缺少 overview 字段')
  if (!Array.isArray(data.picks)) throw new Error('LLM 输出缺少 picks 数组')
  data.picks = data.picks.filter((p) => p && typeof p.title === 'string' && typeof p.url === 'string')
  for (const p of data.picks) {
    p.account = typeof p.account === 'string' ? p.account : ''
    p.note = typeof p.note === 'string' ? p.note : ''
  }
  return data
}

/**
 * One user Message in the exact dsh-llm shape: branded string id,
 * ContentBlock[] content, { kind: 'user' } source.
 */
function userMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/**
 * Consume one auxiliary LLM stream: collect text-delta, remember the finish
 * chunk, throw on hard failures (terminal error / aborted). Finish-kind
 * policy (max-tokens etc.) is each caller's — the batch JSON call treats a
 * truncated JSON as an error, the single-article call accepts the text.
 * @param {(options:object)=>AsyncIterable<object>} stream ctx.llm.stream with provider/model pre-bound.
 * @param {object} p
 * @param {string} p.system
 * @param {string} p.user
 * @param {number} [p.maxTokens]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{text:string, finish:object|null}>}
 */
async function runStreamText(stream, { system, user, maxTokens, signal }) {
  let text = ''
  let finish = null
  for await (const chunk of stream({ system, messages: [userMessage(user)], temperature: 0, maxTokens, signal })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk
  }
  if (finish && finish.kind === 'error') {
    const f = finish.failure || {}
    throw new Error('LLM 摘要调用失败：' + (f.message || f.code || JSON.stringify(f)))
  }
  if (finish && finish.kind === 'aborted') throw new Error('LLM 摘要调用被中止')
  return { text, finish }
}

/**
 * One auxiliary LLM call over the collected items.
 * @param items collected articles (any window).
 * @param {object} p
 * @param {(options:object)=>AsyncIterable<object>} p.stream ctx.llm.stream with provider/model pre-bound.
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.maxTokens]
 * @returns {Promise<{overview:string, picks:Array<object>}>}
 */
export async function summarizeItems(items, { stream, signal, maxTokens = 16384 } = {}) {
  const user = '本次采集到 ' + items.length + ' 篇文章：\n\n' + buildSummaryPayload(items) + '\n\n请严格按系统要求输出 JSON。'
  const { text, finish } = await runStreamText(stream, { system: SUMMARY_SYSTEM, user, maxTokens, signal })
  if (finish && finish.kind === 'max-tokens') {
    throw new Error(
      text.trim()
        ? 'LLM 摘要输出达到 max-tokens 上限且 JSON 不完整：调大 summaryMaxTokens'
        : 'LLM 摘要调用未返回内容（finish: max-tokens）。请设置 summaryReasoningEffort: off，或调大 summaryMaxTokens',
    )
  }
  if (!text.trim()) throw new Error('LLM 摘要调用未返回内容（finish: ' + JSON.stringify(finish) + '）')
  return parseSummary(text)
}

// ── per-article summary (on demand, from the panel button) ─────────────────

export const ITEM_SUMMARY_SYSTEM = [
  '你是微信公众号内容编辑。用户在浏览文章列表，靠你写的摘要决定要不要点开原文。',
  '读完给出的全文，为这一篇写一篇摘要：',
  '1. 忠实原文：不编造、不脑补、不评价，原文没有的信息不写；',
  '2. 覆盖主要观点、关键数据与结论；',
  '3. 长短由内容决定：短文短摘，长文可分点，不设固定字数；',
  '4. 直接输出摘要正文：中文，不用标题、客套话或「本文介绍了」这类开头。',
].join('\n')

/** 送进 LLM 的正文截断上限（字符）：摘要所需的信息集中在正文前段，12000 足够且控制成本。 */
export const MAX_SUMMARY_BODY_CHARS = 12000

/**
 * One auxiliary LLM call summarizing a SINGLE article's body text. Runs
 * outside the collect pipeline (the body is fetched on demand). Output
 * length is the model's call; `maxTokens` is a safety ceiling, not a
 * length target.
 * @param {object} p
 * @param {string} [p.title]
 * @param {string} [p.account]
 * @param {string} p.text article body (plain text)
 * @param {(options:object)=>AsyncIterable<object>} p.stream ctx.llm.stream with provider/model pre-bound.
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.maxTokens]
 * @returns {Promise<string>} the summary text
 */
export async function summarizeArticle({ title, account, text, stream, signal, maxTokens = 16384 } = {}) {
  const body = String(text || '').trim()
  if (!body) throw new Error('文章正文为空，无法生成摘要')
  const clipped = body.length > MAX_SUMMARY_BODY_CHARS
  const user = '公众号：' + (account || '未知') + '\n标题：' + (title || '（无）') + '\n\n正文' + (clipped ? '（前 ' + MAX_SUMMARY_BODY_CHARS + ' 字，后文略）' : '') + '：\n' + body.slice(0, MAX_SUMMARY_BODY_CHARS)
  const { text: out, finish } = await runStreamText(stream, { system: ITEM_SUMMARY_SYSTEM, user, maxTokens, signal })
  // max-tokens here = the summary hit the output ceiling: rare, and the
  // truncated text is still a usable summary.
  if (!out.trim()) throw new Error('LLM 摘要调用未返回内容（finish: ' + JSON.stringify(finish) + '）')
  return out.trim()
}

/**
 * Deterministic summary markdown (the panel renders this; the headline
 * lines carry the '**今日要点**' marker the sidebar list preview parses).
 * @param data parsed summary JSON.
 * @param windowLabel e.g. '当天 2026-08-25' or '近 7 天'.
 * @param stats {items:number, ok:number} collection stats for the footer.
 */
export function renderSummaryMarkdown({ data, windowLabel, stats }) {
  const L = []
  L.push('## 📮 公众号要点 · ' + (windowLabel || ''))
  L.push('')
  L.push('**速览**：' + (data.overview || '（无）'))
  L.push('')
  L.push('> **今日要点**')
  L.push('>')
  const picks = (data.picks || []).slice(0, 10)
  if (!picks.length) {
    L.push('> 本时间窗内暂无突出文章。')
  }
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i]
    L.push('> ' + (i + 1) + '. **' + p.title + '**' + (p.account ? '（' + p.account + '）' : '') + (p.note ? ' — ' + p.note : ''))
  }
  L.push('')
  if (picks.length) {
    L.push('---')
    L.push('')
    for (const p of picks) {
      L.push('- [' + p.title + '](' + p.url + ') · ' + (p.account || '未知'))
    }
    L.push('')
  }
  L.push('共 ' + (stats && stats.items) + ' 篇文章，' + (stats && stats.ok) + ' 个号有更新（每次采集均为最新结果，不做历史去重）。')
  return L.join('\n')
}
