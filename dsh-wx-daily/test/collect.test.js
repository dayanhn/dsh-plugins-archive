import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isoFromUnixSecs, explainSrcErr, parseFetcherResult, mergeFetcherConfig,
  fetcherExitError, windowBounds, localDayKey, zonedDayStart,
  filterByWindow, collect,
} from '../lib/collect.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const FETCHER_JSON = readFileSync(join(FIX, 'fetcher-result.json'), 'utf8')

/** A throwaway fetcher checkout: only bin/weread.mjs existing matters. */
function makeFetcherDir(config) {
  const dir = mkdtempSync(join(tmpdir(), 'wx-daily-fetcher-'))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'weread.mjs'), '// stub')
  if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))
  return dir
}

test('isoFromUnixSecs: seconds, milliseconds, zero, garbage', () => {
  assert.equal(isoFromUnixSecs(1787650200), new Date(1787650200000).toISOString())
  assert.equal(isoFromUnixSecs(1787650200123), new Date(1787650200123).toISOString())
  assert.equal(isoFromUnixSecs('1787650200'), new Date(1787650200000).toISOString())
  assert.equal(isoFromUnixSecs(0), '')
  assert.equal(isoFromUnixSecs('nope'), '')
})

test('explainSrcErr: -2010 / -2041 get hints, others pass through', () => {
  assert.match(explainSrcErr('errCode=-2010'), /重新扫码登录/)
  assert.match(explainSrcErr('errCode=-2041'), /阅读器标签页/)
  assert.equal(explainSrcErr('evaluate 失败: timeout'), 'evaluate 失败: timeout')
})

test('parseFetcherResult: valid fixture, invalid JSON, missing sources', () => {
  const r = parseFetcherResult(FETCHER_JSON)
  assert.equal(r.sources.length, 4)
  assert.equal(r.sources[0].bookId, 'MP_WXS_0001')
  assert.throws(() => parseFetcherResult('not json'), /不是合法 JSON/)
  assert.throws(() => parseFetcherResult('{"meta":{}}'), /sources/)
})

test('mergeFetcherConfig: replaces accounts, preserves static keys, fills defaults', () => {
  const existing = { chromePort: 9333, maxRequestsPerDay: 55, readerUrl: 'https://x' }
  const merged = mergeFetcherConfig(existing, [{ name: 'a', bookId: 'MP_WXS_1' }])
  assert.equal(merged.maxRequestsPerDay, 55)
  assert.equal(merged.readerUrl, 'https://x')
  assert.equal(merged.requestIntervalMs, 3000)
  assert.deepEqual(merged.accounts, [{ name: 'a', bookId: 'MP_WXS_1' }])
  assert.deepEqual(mergeFetcherConfig(null, []), {
    ...{ chromePort: 9333, chromeProfileDir: '~/.weread-mp-fetcher/chrome-profile', maxRunsPerDay: 2, requestIntervalMs: 3000, maxRequestsPerDay: 40, maxPagesPerRun: 3, statePath: '~/.weread-mp-fetcher/quota.json', outDir: 'out' },
    readerUrl: '',
    accounts: [],
  })
})

test('fetcherExitError: quota / usage / all-failed / unknown carry the stderr tail', () => {
  assert.match(fetcherExitError(3, 'line1\n今日已抓 2/2 次,达到上限,本次跳过。'), /配额已用完.*2\/2/s)
  assert.match(fetcherExitError(2, 'config bad'), /拒绝执行/)
  assert.match(fetcherExitError(1, '  旺小哥: errCode=-2041\n  傅盛: errCode=-2041'), /全部公众号抓取失败/)
  assert.match(fetcherExitError(-1, 'ENOENT'), /异常退出/)
  assert.equal(fetcherExitError(3, ''), '今日采集配额已用完（微信读书防风控闸门，明天再试）')
})

test('windowBounds: today = local midnight → now in the zone', () => {
  // 2026-08-25T01:30Z is 09:30 in Asia/Shanghai.
  const now = new Date('2026-08-25T01:30:00Z')
  const w = windowBounds('today', 'Asia/Shanghai', now)
  assert.equal(w.fromMs, Date.UTC(2026, 7, 24, 16, 0, 0))
  assert.equal(w.toMs, now.getTime())
  assert.ok(w.label.includes('2026-08-25'))
})

test('windowBounds: 3d / 7d are rolling windows', () => {
  const now = new Date('2026-08-25T01:30:00Z')
  assert.equal(windowBounds('3d', 'Asia/Shanghai', now).fromMs, now.getTime() - 3 * 86400000)
  assert.equal(windowBounds('7d', 'Asia/Shanghai', now).fromMs, now.getTime() - 7 * 86400000)
})

test('windowBounds: custom range = inclusive calendar days', () => {
  const w = windowBounds({ from: '2026-08-20', to: '2026-08-22' }, 'Asia/Shanghai')
  assert.equal(w.fromMs, Date.UTC(2026, 7, 19, 16, 0, 0))
  assert.equal(w.toMs, Date.UTC(2026, 7, 22, 16, 0, 0) - 1)
  assert.equal(w.label, '2026-08-20 ~ 2026-08-22')
})

test('zonedDayStart / localDayKey round-trip across the zone', () => {
  assert.equal(zonedDayStart('2026-08-25', 'Asia/Shanghai'), Date.UTC(2026, 7, 24, 16, 0, 0))
  // negative offset (EDT = UTC-4 in August)
  assert.equal(zonedDayStart('2026-08-25', 'America/New_York'), Date.UTC(2026, 7, 25, 4, 0, 0))
  // far-east offset UTC+12
  assert.equal(zonedDayStart('2026-08-25', 'Pacific/Auckland'), Date.UTC(2026, 7, 24, 12, 0, 0))
  assert.equal(localDayKey(new Date('2026-08-25T01:30:00Z'), 'Asia/Shanghai'), '2026-08-25')
  assert.equal(localDayKey(new Date('2026-08-24T15:59:59Z'), 'Asia/Shanghai'), '2026-08-24')
})

test('filterByWindow: in-window kept, older and undated dropped', () => {
  const items = [
    { title: 'a', link: 'x1', publishedAt: '2026-08-25T09:30:00.000Z' },
    { title: 'b', link: 'x2', publishedAt: '2026-08-22T09:30:00.000Z' },
    { title: 'no date', link: 'x3', publishedAt: '' },
  ]
  const out = filterByWindow(items, Date.UTC(2026, 7, 24, 16), Date.UTC(2026, 7, 25, 12))
  assert.deepEqual(out.map((i) => i.link), ['x1'])
})

test('collect: per-account statuses, window filter, newest-first items', async () => {
  const dir = makeFetcherDir({ maxRequestsPerDay: 55 })
  const runCalls = []
  const runImpl = async (d, pages) => {
    runCalls.push([d, pages])
    return { code: 0, stdout: FETCHER_JSON, stderr: 'progress noise' }
  }
  const now = new Date('2026-08-25T01:30:00Z')
  const window = { ...windowBounds('today', 'Asia/Shanghai', now), toMs: Date.UTC(2026, 7, 25, 12) }
  const r = await collect({
    fetcherDir: dir,
    fetcherPages: 1,
    accounts: [
      { name: '数字生命卡兹克', bookId: 'MP_WXS_0001' },
      { name: 'agent橘', bookId: 'MP_WXS_0002' },
      { name: 'Droca 正在 VibeCoding', bookId: 'MP_WXS_0003' },
      { name: '旺小哥', bookId: 'MP_WXS_0004' },
      { name: '傅盛', bookId: '' },
      { name: '禁用号', bookId: 'MP_WXS_9999', enabled: false },
    ],
    window,
    runImpl,
  })
  assert.deepEqual(r.accounts.map((a) => [a.name, a.status, a.count]), [
    ['数字生命卡兹克', 'ok', 2],
    ['agent橘', 'ok', 1],
    ['Droca 正在 VibeCoding', 'empty', 0],
    ['旺小哥', 'error', 0],
    ['傅盛', 'nofeed', 0],
  ])
  assert.deepEqual(r.stats, { ok: 2, empty: 1, nofeed: 1, error: 1, items: 3 })
  assert.deepEqual(r.items.map((i) => i.url), [
    'https://mp.weixin.qq.com/s/fixture-aaa111',
    'https://mp.weixin.qq.com/s/fixture-ddd444',
    'https://mp.weixin.qq.com/s/fixture-bbb222',
  ])
  assert.equal(r.items[0].configName, '数字生命卡兹克')
  assert.match(r.accounts[3].error, /-2041/)
  assert.match(r.accounts[4].error, /缺 bookId/)
  // the disabled account never reaches the fetcher
  assert.deepEqual(runCalls, [[dir, 1]])
  // config.json: accounts replaced (disabled excluded), static key preserved
  const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.deepEqual(written.accounts.map((a) => a.bookId), ['MP_WXS_0001', 'MP_WXS_0002', 'MP_WXS_0003', 'MP_WXS_0004'])
  assert.equal(written.maxRequestsPerDay, 55)
})

test('collect: quota-exhausted (exit 3) throws a run-level error', async () => {
  const dir = makeFetcherDir()
  await assert.rejects(
    collect({
      fetcherDir: dir,
      accounts: [{ name: '数字生命卡兹克', bookId: 'MP_WXS_0001' }],
      window: { fromMs: 0, toMs: 1, label: 't' },
      runImpl: async () => ({ code: 3, stdout: '', stderr: '今日已抓 2/2 次,达到上限,本次跳过。' }),
    }),
    /配额已用完/,
  )
})

test('collect: all sources failed (exit 1) throws with the per-account tail', async () => {
  const dir = makeFetcherDir()
  await assert.rejects(
    collect({
      fetcherDir: dir,
      accounts: [{ name: '旺小哥', bookId: 'MP_WXS_0004' }],
      window: { fromMs: 0, toMs: 1, label: 't' },
      runImpl: async () => ({ code: 1, stdout: '', stderr: '  旺小哥: errCode=-2041' }),
    }),
    /全部公众号抓取失败/,
  )
})

test('collect: no subscribed accounts → all nofeed, fetcher never invoked', async () => {
  const dir = makeFetcherDir()
  const r = await collect({
    fetcherDir: dir,
    accounts: [{ name: '傅盛', bookId: '' }, { name: '卢松松' }],
    window: { fromMs: 0, toMs: 1, label: 't' },
    runImpl: async () => { throw new Error('must not run') },
  })
  assert.deepEqual(r.accounts.map((a) => [a.name, a.status]), [['傅盛', 'nofeed'], ['卢松松', 'nofeed']])
  assert.deepEqual(r.stats, { ok: 0, empty: 0, nofeed: 2, error: 0, items: 0 })
})

test('collect: missing fetcherDir fails loudly before any run', async () => {
  await assert.rejects(
    collect({
      fetcherDir: '/nonexistent/path',
      accounts: [{ name: 'a', bookId: 'MP_WXS_1' }],
      window: { fromMs: 0, toMs: 1, label: 't' },
      runImpl: async () => { throw new Error('must not run') },
    }),
    /weread-mp-fetcher 未找到/,
  )
})
