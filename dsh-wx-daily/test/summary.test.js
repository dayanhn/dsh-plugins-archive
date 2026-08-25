import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSummaryPayload, parseSummary, renderSummaryMarkdown, summarizeItems } from '../lib/summary.js'

const ITEMS = [
  { account: '数字生命卡兹克', title: 'Claude Code 深度实测', url: 'https://mp.weixin.qq.com/s/a1', publishedAt: '2026-08-25T09:30:00.000Z', summary: '三周体验，结论如下' },
  { account: '傅盛', title: '2026 是 AI 应用繁荣年', url: 'https://mp.weixin.qq.com/s/b2', publishedAt: '2026-08-25T01:00:00.000Z', summary: '' },
]

test('buildSummaryPayload: numbered lines carry account, time, title, url, snippet', () => {
  const p = buildSummaryPayload(ITEMS)
  const lines = p.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^1\. \[数字生命卡兹克\] 08-25 09:30 Claude Code 深度实测 \| https:\/\/mp\.weixin\.qq\.com\/s\/a1 \| 三周体验，结论如下$/)
  assert.match(lines[1], /^2\. \[傅盛\] 08-25 01:00 2026 是 AI 应用繁荣年 \| https:\/\/mp\.weixin\.qq\.com\/s\/b2$/)
})

test('parseSummary: plain / fenced / prose-wrapped JSON; invalid shapes rejected', () => {
  const good = { overview: '两号有更新', picks: [{ title: 't', url: 'u', account: 'a', note: 'n' }] }
  assert.deepEqual(parseSummary(JSON.stringify(good)), good)
  assert.deepEqual(parseSummary('前言 ```json\n' + JSON.stringify(good) + '\n``` 后语').overview, '两号有更新')
  assert.throws(() => parseSummary('no json here'), /未找到 JSON/)
  assert.throws(() => parseSummary('{"picks": []}'), /overview/)
  // picks entries missing title/url are dropped, not fatal
  const trimmed = parseSummary(JSON.stringify({ overview: 'x', picks: [{ title: 't', url: 'u' }, { url: 'only-url' }] }))
  assert.equal(trimmed.picks.length, 1)
})

test('renderSummaryMarkdown: 今日要点 marker, bold headline lines, link section, footer', () => {
  const md = renderSummaryMarkdown({
    data: { overview: '两号有更新，热点在 AI 编程', picks: [{ title: 'Claude Code 深度实测', url: 'https://mp.weixin.qq.com/s/a1', account: '数字生命卡兹克', note: '实测干货' }] },
    windowLabel: '当天 2026-08-25',
    stats: { items: 2, ok: 2 },
  })
  assert.ok(md.includes('## 📮 公众号要点 · 当天 2026-08-25'))
  assert.ok(md.includes('> **今日要点**'))
  // the sidebar list preview parses these bold headline lines
  const headline = md.split('\n').find((l) => /^>\s*1\.\s*\*\*(.+?)\*\*/.test(l))
  assert.ok(headline && headline.includes('Claude Code 深度实测'))
  assert.ok(headline.includes('（数字生命卡兹克）'))
  assert.ok(md.includes('- [Claude Code 深度实测](https://mp.weixin.qq.com/s/a1) · 数字生命卡兹克'))
  assert.ok(md.includes('共 2 篇文章，2 个号有更新'))
  assert.ok(md.includes('不做历史去重'))
})

function stubStream(chunks) {
  return async function* () { for (const c of chunks) yield c }
}

test('summarizeItems: consumes text-delta chunks and parses JSON', async () => {
  const data = { overview: 'ok', picks: [] }
  const out = await summarizeItems(ITEMS, { stream: stubStream([
    { type: 'text-delta', text: JSON.stringify(data).slice(0, 10) },
    { type: 'text-delta', text: JSON.stringify(data).slice(10) },
    { type: 'finish', kind: 'stop' },
  ]) })
  assert.deepEqual(out, data)
})

test('summarizeItems: terminal error finish surfaces the failure message', async () => {
  await assert.rejects(
    summarizeItems(ITEMS, { stream: stubStream([{ type: 'finish', kind: 'error', failure: { message: 'quota exceeded' } }]) }),
    /quota exceeded/,
  )
})

test('summarizeItems: max-tokens without text gives the reasoning-budget hint', async () => {
  await assert.rejects(
    summarizeItems(ITEMS, { stream: stubStream([{ type: 'finish', kind: 'max-tokens' }]) }),
    /summaryMaxTokens|reasoningEffort/,
  )
})
