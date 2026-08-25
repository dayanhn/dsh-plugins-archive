import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreItem, normUrl, stripTracking, GITHUB_REPOS, RSS_FEEDS, KEYWORDS, withRetry } from '../lib/collect.js'

test('scoreItem: inference terms accumulate weights', () => {
  const { score, matched } = scoreItem('KV cache compression for LLM inference serving with speculative decoding')
  assert.ok(score >= 7, 'score was ' + score)
  assert.ok(matched.length >= 3)
})

test('scoreItem: unrelated text scores below the paper gate', () => {
  const { score } = scoreItem('A new framework for frontend styling and design tokens')
  assert.ok(score < 2, 'score was ' + score)
})

test('withRetry: 429 gets a longer backoff and up to 3 attempts', async () => {
  let calls = 0
  const flaky = async () => {
    calls += 1
    if (calls <= 2) throw new Error('HTTP 429')
    return 'ok'
  }
  const t0 = Date.now()
  assert.equal(await withRetry(flaky, 1, 20), 'ok')
  assert.equal(calls, 3)
  assert.ok(Date.now() - t0 >= 120, 'two 4x backoffs of 20ms each')
})

test('withRetry: exhausted attempts rethrow the last error', async () => {
  let calls = 0
  const dead = async () => { calls += 1; throw new Error('HTTP 429') }
  await assert.rejects(withRetry(dead, 1, 5), /HTTP 429/)
  assert.equal(calls, 3)
})

test('normUrl: arXiv http->https and version suffix stripped', () => {
  assert.equal(normUrl('http://arxiv.org/abs/2608.1234v2/'), 'https://arxiv.org/abs/2608.1234')
  assert.equal(normUrl('https://arxiv.org/abs/2608.1234'), 'https://arxiv.org/abs/2608.1234')
})

test('normUrl: meaningful queries kept, tracking params stripped, trailing punctuation stripped', () => {
  assert.equal(normUrl('https://news.ycombinator.com/item?id=49424387'), 'https://news.ycombinator.com/item?id=49424387')
  assert.equal(normUrl('https://ex.com/a?utm_source=x&id=5'), 'https://ex.com/a?id=5')
  assert.equal(normUrl('https://ex.com/a.'), 'https://ex.com/a')
})

test('stripTracking: utm_* and known params removed, others kept', () => {
  assert.equal(stripTracking('https://a.b/c?utm_medium=rss&q=1'), 'https://a.b/c?q=1')
  assert.equal(stripTracking('https://a.b/c?utm_source=x'), 'https://a.b/c')
})

test('source lists: vllm-ascend and the Ascend stack are tracked, no duplicates', () => {
  for (const repo of [
    'vllm-project/vllm-ascend',
    'Ascend/MindIE-LLM',
    'Ascend/MindSpeed-LLM',
    'Ascend/pytorch',
    'Ascend/cann-container-image',
    'mindspore-ai/mindspore',
  ]) assert.ok(GITHUB_REPOS.includes(repo), 'missing ' + repo)
  assert.equal(new Set(GITHUB_REPOS).size, GITHUB_REPOS.length)
  assert.ok(RSS_FEEDS.every((f) => f.tier === 'focused' || f.tier === 'general'), 'every feed needs a tier')
  assert.ok(KEYWORDS.length >= 15)
})
