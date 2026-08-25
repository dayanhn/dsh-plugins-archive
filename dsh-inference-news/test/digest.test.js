import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseCuration, buildCurationPayload, renderDigest, writeDigest, digestDate, headerDate, curateItems } from '../lib/digest.js'

const SAMPLE = {
  headlines: [{ title: 'T1', why: 'w', links: ['https://a.b/c'] }],
  releases: [{ repo: 'vLLM', version: 'v0.28.0', date: '08-24', link: 'https://g.h/r', bullets: ['b1', 'b2'] }],
  papers: [
    { title: 'Pipe | Title', link: 'https://arxiv.org/abs/1', category: 'cs.LG', note: 'n' },
    { title: 'NoCat', link: 'https://arxiv.org/abs/2', category: '', note: 'n2' },
  ],
  community: [],
  note: '',
}
const COLLECTED = {
  itemCount: 10,
  sources: [
    { name: 'arXiv', status: 'ok', fetched: 5 },
    { name: 'HF Daily Papers', status: 'ok', fetched: 2 },
    { name: 'GitHub:vllm-project/vllm', status: 'ok', fetched: 1 },
    { name: 'GitHub:Ascend/MindIE-LLM', status: 'error', error: 'timeout' },
    { name: 'HackerNews:KV cache', status: 'ok', fetched: 3 },
    { name: 'vLLM Blog', status: 'ok', fetched: 1 },
  ],
}

test('parseCuration: plain JSON', () => {
  const data = parseCuration(JSON.stringify(SAMPLE))
  assert.equal(data.headlines.length, 1)
  assert.equal(data.note, '')
})

test('parseCuration: code fences + surrounding prose tolerated', () => {
  const wrapped = '好的，如下：\n' + '```json\n' + JSON.stringify(SAMPLE) + '\n' + '```\n希望有帮助'
  const data = parseCuration(wrapped)
  assert.equal(data.releases[0].repo, 'vLLM')
})

test('parseCuration: missing array field throws', () => {
  assert.throws(() => parseCuration('{"headlines": []}'))
  assert.throws(() => parseCuration('no json here'))
})

test('buildCurationPayload: numbered lines carrying url, meta and snippet', () => {
  const items = [
    { kind: 'paper', title: 'A', url: 'https://arxiv.org/abs/9', category: 'cs.LG', upvotes: 5, snippet: 's1 s2' },
    { kind: 'community', title: 'B', url: 'https://hn.x/item?id=1', points: 10, comments: 2 },
  ]
  const p = buildCurationPayload(items)
  assert.ok(p.startsWith('1. [paper] A | https://arxiv.org/abs/9 | cs.LG · ⬆5 | s1 s2'))
  assert.ok(p.includes('2. [community] B | https://hn.x/item?id=1 | ▲ 10 / 2 评论'))
})

test('renderDigest: full structure, pipe escaping, empty sections, source footer', () => {
  const md = renderDigest({ date: '2026-08-25', config: { timezone: 'Asia/Shanghai' }, data: SAMPLE, collected: COLLECTED })
  assert.ok(md.startsWith('# 📰 大模型推理日报 · 2026年8月25日'), md.slice(0, 60))
  assert.ok(md.includes('> 1. **T1** — w'))
  assert.ok(md.includes('### vLLM'))
  assert.ok(md.includes('- **v0.28.0** · 08-24 · [Release](https://g.h/r)'))
  assert.ok(md.includes('  - b1'))
  assert.ok(md.includes('Pipe \\| Title'), 'pipe should be escaped in table cell')
  assert.ok(md.includes('今日无入选社区热点'))
  assert.ok(md.includes('⚠️ 1/2'), 'github footer: ' + (md.match(/GitHub Releases.*/) || [''])[0])
  assert.ok(md.includes('✅ 1/1'), 'hn footer: ' + (md.match(/Hacker News.*/) || [''])[0])
  assert.ok(md.includes('<details>'))
  assert.ok(md.trimEnd().endsWith('</details>'))
})

test('writeDigest: same-day file written, content round-trips', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-news-test-'))
  const f1 = writeDigest({ outputDir: dir, date: '2026-08-25', markdown: '# x' })
  assert.equal(path.basename(f1), '2026-08-25.md')
  assert.equal(readFileSync(f1, 'utf8'), '# x')
  const f2 = writeDigest({ outputDir: dir, date: '2026-08-25', markdown: '# y' })
  assert.equal(f1, f2)
  assert.equal(readFileSync(f1, 'utf8'), '# y')
})

test('curateItems: collects text-deltas, sends a well-formed Message, parses the JSON', async () => {
  let seen
  const stream = async function* (opts) {
    seen = opts
    const full = JSON.stringify(SAMPLE)
    for (const piece of [full.slice(0, 20), full.slice(20)]) yield { type: 'text-delta', text: piece }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const data = await curateItems([{ kind: 'paper', title: 'T', url: 'https://x.y' }], { stream, signal: new AbortController().signal })
  assert.equal(data.papers.length, 2)
  const m = seen.messages[0]
  assert.equal(m.role, 'user')
  assert.ok(typeof m.id === 'string' && m.id.length >= 32, 'branded string id')
  assert.ok(Array.isArray(m.content) && m.content[0].type === 'text', 'ContentBlock[] content')
  assert.deepEqual(m.source, { kind: 'user' })
  assert.equal(seen.temperature, 0)
  assert.equal(seen.maxTokens, 16384)
})

test('curateItems: surfaces adapter finish errors with the real failure', async () => {
  const stream = async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', message: 'boom local model' } } }
  }
  await assert.rejects(
    curateItems([{ kind: 'paper', title: 'T', url: 'u' }], { stream, signal: new AbortController().signal }),
    /boom local model/,
  )
})

test('curateItems: aborted and empty finishes throw specific errors', async () => {
  const aborted = async function* () { yield { type: 'finish', reason: { kind: 'aborted' } } }
  await assert.rejects(curateItems([], { stream: aborted, signal: new AbortController().signal }), /被中止/)
  const empty = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  await assert.rejects(curateItems([], { stream: empty, signal: new AbortController().signal }), /未返回内容/)
})

test('curateItems: max-tokens finish yields actionable errors (empty vs partial)', async () => {
  const emptyMaxTokens = async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } }
  await assert.rejects(
    curateItems([], { stream: emptyMaxTokens, signal: new AbortController().signal }),
    /推理 token 耗尽|curationReasoningEffort/,
  )
  const partialMaxTokens = async function* () {
    yield { type: 'text-delta', text: '{"headlines": [' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }
  await assert.rejects(
    curateItems([], { stream: partialMaxTokens, signal: new AbortController().signal }),
    /JSON 不完整/,
  )
})

test('digestDate / headerDate respect the zone', () => {
  assert.equal(digestDate('Asia/Shanghai', new Date('2026-08-25T01:00:00Z')), '2026-08-25')
  assert.equal(digestDate('UTC', new Date('2026-08-25T01:00:00Z')), '2026-08-25')
  assert.equal(digestDate('UTC', new Date('2026-08-24T20:00:00Z')), '2026-08-24')
  assert.ok(headerDate('2026-08-25').includes('8月25日'))
})
