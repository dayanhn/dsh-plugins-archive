#!/usr/bin/env node
/**
 * dsh-wx-daily collector. Zero dependencies (Node >= 18).
 *
 * Source of truth is a LOCAL 微信读书 session: the collector drives the
 * weread-mp-fetcher CLI, which runs in-page JS inside a dedicated Chrome
 * profile (port 9333) logged into 微信读书. No third-party relay — every
 * request goes from this machine to WeRead directly, and the session never
 * leaves the machine.
 *
 * Pipeline per run:
 *   1. enabled accounts WITH a bookId (MP_WXS_…) are merged into the
 *      fetcher's config.json (the fetcher's static settings — chrome port,
 *      quota gates — are preserved),
 *   2. `node <fetcherDir>/bin/weread.mjs --pages N` runs; JSON result on
 *      stdout, progress on stderr,
 *   3. sources are matched back to accounts by bookId, window-filtered,
 *      aggregated newest-first.
 *
 * Every collection window is re-fetched from scratch on purpose — there is
 * NO cross-run dedup and NO "already collected today" state; latest.json is
 * overwritten each run with the fresh view. The fetcher's own daily quota
 * (maxRunsPerDay / maxRequestsPerDay) caps how often a run may happen —
 * that is a WeRead risk-control budget, not dedup.
 *
 * Account statuses: ok / empty / nofeed (enabled but no bookId yet) /
 * error. Per-account failures are isolated. Run-level failures (quota
 * exhausted, all sources failed, fetcher missing) throw.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const BOOK_ID_RE = /^MP_WXS_\d+$/

/**
 * 微信读书 createTime (unix seconds) → ISO; tolerate ms as well.
 * @param {number|string} t
 * @returns {string} ISO string, or '' when unparseable.
 */
export function isoFromUnixSecs(t) {
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n < 1e12 ? n * 1000 : n)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}

/**
 * Human-readable hint for the err strings the fetcher emits (its wording is
 * load-bearing for the -2041 auto-diagnose, so match on the codes).
 * @param {string} err
 */
export function explainSrcErr(err) {
  const s = String(err || '')
  if (s.includes('-2010')) return '微信读书登录已失效（errCode=-2010）：到专用 Chrome 窗口里重新扫码登录微信读书'
  if (s.includes('-2041')) return '微信读书接口拒绝（errCode=-2041）：保持阅读器标签页常开；若页面弹出验证码，在 Chrome 里手动完成后再采'
  return s
}

/**
 * Parse the fetcher's stdout (pretty-printed JSON).
 * @param {string} text
 * @returns {{meta:{pages:number,requestsTotal:number},sources:Array<{name:string,bookId:string,items?:Array<{t:number,title:string,url:string,rid:string}>,err?:string,partialErr?:string}>}}
 */
export function parseFetcherResult(text) {
  let body
  try {
    body = JSON.parse(String(text || ''))
  } catch {
    throw new Error('fetcher 输出不是合法 JSON（本轮结果已丢失，重新点「⚡ 采集」即可）')
  }
  if (!body || !Array.isArray(body.sources)) throw new Error('fetcher 输出缺少 sources 数组')
  return body
}

// Static fetcher settings used only when config.json is missing; a present
// config.json always wins for these keys (they are the user's risk budget).
const FETCHER_DEFAULTS = {
  chromePort: 9333,
  chromeProfileDir: '~/.weread-mp-fetcher/chrome-profile',
  maxRunsPerDay: 2,
  requestIntervalMs: 3000,
  maxRequestsPerDay: 40,
  maxPagesPerRun: 3,
  statePath: '~/.weread-mp-fetcher/quota.json',
  outDir: 'out',
}

/**
 * Merge the plugin's account list into the fetcher config. The plugin's
 * accounts.json is the source of truth for WHICH accounts; the fetcher's
 * config.json owns the transport + quota settings.
 * @param {object|null} existing parsed config.json (or null when absent)
 * @param {Array<{name:string,bookId:string}>} accounts
 */
export function mergeFetcherConfig(existing, accounts) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {}
  delete base.accounts
  return {
    ...FETCHER_DEFAULTS,
    ...base,
    readerUrl: base.readerUrl ?? '',
    accounts: accounts.map((a) => ({ name: a.name, bookId: a.bookId })),
  }
}

function readFetcherConfig(dir) {
  const p = path.join(dir, 'config.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Run the fetcher CLI with an arbitrary argv. Proxy vars are stripped from
 * the env: the WeRead traffic is a domestic site reached directly, and a
 * socks all_proxy leaks into the child exactly like it did for the
 * wewe-rss server (axios cannot speak socks and fails with
 * ERR_INVALID_PROTOCOL).
 * @param {string} fetcherDir
 * @param {string[]} args e.g. ['--pages','1'] or ['--content','MP_WXS_...']
 * @param {AbortSignal} [signal]
 * @returns {Promise<{code:number,stdout:string,stderr:string}>}
 */
export async function runFetcher(fetcherDir, args, signal) {
  const { spawn } = await import('node:child_process')
  const env = { ...process.env }
  for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[k]
  return await new Promise((resolveP) => {
    const child = spawn(process.execPath, [path.join(fetcherDir, 'bin', 'weread.mjs'), ...args], {
      env,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 必须按 Buffer 累积、最后一次性 utf8 解码：pipe 分块边界可能落在多字节
    // 中文字符中间，逐块 Buffer→string 会插入 U+FFFD，整份 JSON 因此解析失败
    // （21 个号 ~300KB 中文结果，逐次拼接几乎必炸）。
    const out = []
    const errOut = []
    child.stdout.on('data', (c) => { out.push(c) })
    child.stderr.on('data', (c) => { errOut.push(c) })
    const finish = (code) => resolveP({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(errOut).toString('utf8'),
    })
    child.on('error', (err) => {
      errOut.push(Buffer.from('\n' + String((err && err.message) || err)))
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

async function defaultRun(fetcherDir, pages, signal) {
  return runFetcher(fetcherDir, ['--pages', String(pages)], signal)
}

/**
 * Map a non-zero fetcher exit code to a run-level error. The fetcher writes
 * the actionable message to stderr (quota lines, per-account failures), so
 * the tail is the payload.
 * @param {number} code
 * @param {string} stderr
 */
export function fetcherExitError(code, stderr) {
  const tail = String(stderr || '').trim().split('\n').slice(-3).join(' ').slice(-300)
  const head =
    code === 3 ? '今日采集配额已用完（微信读书防风控闸门，明天再试）'
    : code === 2 ? 'fetcher 拒绝执行（配置/用法错误或请求预算不足）'
      : code === 1 ? '全部公众号抓取失败'
        : 'fetcher 异常退出（code ' + code + '）'
  return head + (tail ? '：' + tail : '')
}

/**
 * The full collection pipeline.
 * @param {object} p
 * @param {string} p.fetcherDir local weread-mp-fetcher checkout
 * @param {number} [p.fetcherPages] pages per account (1 page ≈ 70–80 篇)
 * @param {Array<{name:string,bookId?:string,enabled?:boolean}>} p.accounts
 * @param {{fromMs:number,toMs:number,label:string}} p.window
 * @param {AbortSignal} [p.signal]
 * @param {(dir:string,pages:number,signal?:AbortSignal)=>Promise<{code:number,stdout:string,stderr:string}>} [p.runImpl] test injection
 * @returns {Promise<{
 *   collectedAt: string,
 *   window: {fromMs:number,toMs:number,label:string},
 *   accounts: Array<{name:string,status:'ok'|'empty'|'nofeed'|'error',count:number,error?:string,articles:Array<object>}>,
 *   items: Array<{account:string,configName:string,title:string,url:string,rid:string,publishedAt:string,summary:string}>,
 *   stats: {ok:number,empty:number,nofeed:number,error:number,items:number}
 * }>}
 */
export async function collect({ fetcherDir, fetcherPages = 1, accounts, window, signal, runImpl } = {}) {
  const dir = String(fetcherDir || '').trim()
  if (!dir || !existsSync(path.join(dir, 'bin', 'weread.mjs'))) {
    throw new Error('weread-mp-fetcher 未找到（fetcherDir=' + (dir || '未配置') + '）——先 git clone 或改 fetcherDir 配置')
  }
  const result = {
    collectedAt: new Date().toISOString(),
    window: { ...window },
    accounts: [],
    items: [],
    stats: { ok: 0, empty: 0, nofeed: 0, error: 0, items: 0 },
  }
  const enabled = (accounts || []).filter((a) => a && a.name && a.enabled !== false)
  const subscribed = enabled.filter((a) => BOOK_ID_RE.test(String(a.bookId || '')))
  if (!subscribed.length) {
    // Nothing to fetch: report the pending accounts and stop before touching
    // the fetcher (an empty account list would make it exit 2 anyway).
    for (const acc of enabled) {
      const report = { name: acc.name, status: 'nofeed', count: 0, articles: [], error: '尚未订阅（缺 bookId）——给一篇该号的文章链接完成添加' }
      result.accounts.push(report)
      result.stats.nofeed += 1
    }
    return result
  }

  // 1) sync the account list into the fetcher config (transport/quota keys preserved).
  //    Atomic (tmp + rename): a concurrent --content run must never observe a
  //    half-written config.json.
  const cfgPath = path.join(dir, 'config.json')
  writeFileSync(cfgPath + '.tmp-' + process.pid, JSON.stringify(mergeFetcherConfig(readFetcherConfig(dir), subscribed), null, 2) + '\n')
  renameSync(cfgPath + '.tmp-' + process.pid, cfgPath)

  // 2) run the fetcher once for all accounts (serial, 3s gaps, quota-gated).
  const { code, stdout, stderr } = await (runImpl || defaultRun)(dir, fetcherPages, signal)
  if (code !== 0) throw new Error(fetcherExitError(code, stderr))
  const parsed = parseFetcherResult(stdout)
  const byId = new Map(parsed.sources.map((s) => [String(s.bookId || ''), s]))

  // 3) match back by bookId (exact — no name guessing), window-filter.
  for (const acc of enabled) {
    const report = { name: acc.name, status: 'error', count: 0, articles: [] }
    if (!BOOK_ID_RE.test(String(acc.bookId || ''))) {
      report.status = 'nofeed'
      report.error = '尚未订阅（缺 bookId）——给一篇该号的文章链接完成添加'
    } else {
      const src = byId.get(acc.bookId)
      if (!src) {
        report.error = 'fetcher 输出中没有该号（bookId ' + acc.bookId + '）'
      } else if (src.err) {
        report.error = explainSrcErr(src.err)
      } else {
        const all = []
        for (const it of src.items || []) {
          // 无标题的文章直接过滤（不显示）：留 URL 当标题没有任何信息量。
          const title = String(it.title || '').trim()
          if (!title) continue
          all.push({ title, link: it.url || '', publishedAt: isoFromUnixSecs(it.t), rid: String(it.rid || '') })
        }
        const inWin = filterByWindow(all, window.fromMs, window.toMs)
        report.articles = inWin.map((it) => ({
          configName: acc.name,
          account: src.name || acc.name,
          title: it.title,
          url: it.link,
          rid: it.rid,
          publishedAt: it.publishedAt,
          summary: '',
        }))
        report.status = inWin.length ? 'ok' : 'empty'
        report.count = inWin.length
        if (src.partialErr) report.error = '部分页抓取失败：' + src.partialErr
        result.items.push(...report.articles)
      }
    }
    result.accounts.push(report)
    result.stats[report.status === 'ok' ? 'ok' : report.status] += 1
    result.stats.items += report.articles.length
  }

  // Newest first for the aggregated view.
  result.items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
  return result
}

/**
 * Resolve a window spec to epoch-millis bounds in the given IANA zone.
 * @param {'today'|'3d'|'7d'|{from:string,to:string}} window
 *   'today' = local midnight → now; 'Nd' = N×24h before now; custom =
 *   {from:'YYYY-MM-DD', to:'YYYY-MM-DD'} inclusive calendar days (from 00:00
 *   → to 23:59:59.999 local).
 * @param {string} timezone IANA zone, e.g. 'Asia/Shanghai'.
 * @param {Date} [now]
 * @returns {{fromMs:number, toMs:number, label:string}}
 */
export function windowBounds(window, timezone, now = new Date()) {
  if (window && typeof window === 'object' && window.from && window.to) {
    const fromMs = zonedDayStart(window.from, timezone)
    const toMs = zonedDayStart(window.to, timezone) + 86_400_000 - 1
    return { fromMs, toMs, label: `${window.from} ~ ${window.to}` }
  }
  const name = typeof window === 'string' ? window : 'today'
  const toMs = now.getTime()
  const fromMs = name === '3d' ? toMs - 3 * 86_400_000
    : name === '7d' ? toMs - 7 * 86_400_000
      : zonedDayStart(localDayKey(now, timezone), timezone)
  return { fromMs, toMs, label: name === 'today' ? `当天 ${localDayKey(now, timezone)}` : `近 ${name.slice(0, -1)} 天` }
}

/** 'YYYY-MM-DD' of `date` in `timezone`. */
export function localDayKey(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** Epoch ms of local midnight for calendar day 'YYYY-MM-DD' in `timezone`. */
export function zonedDayStart(day, timezone) {
  // Lower bound on the zone-rendered day key: the first instant whose
  // local date is >= `day` is the zone's midnight for `day`. The search
  // band spans the UTC-date anchor ± (24h + 14h) so every real offset
  // (incl. DST transitions) keeps the boundary strictly inside.
  const [y, mo, d] = day.split('-').map(Number)
  const anchor = Date.UTC(y, mo - 1, d)
  let lo = anchor - 38 * 3_600_000
  let hi = anchor + 38 * 3_600_000
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (localDayKey(new Date(mid), timezone) >= day) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Keep items whose publishedAt falls inside [fromMs, toMs]. Items with an
 *  unparseable date are dropped (the fetcher always emits createTime). */
export function filterByWindow(items, fromMs, toMs) {
  const out = []
  for (const it of items || []) {
    const t = it.publishedAt ? Date.parse(it.publishedAt) : NaN
    if (Number.isFinite(t) && t >= fromMs && t <= toMs) out.push(it)
  }
  return out
}

// ── CLI: manual collection for debugging ──────────────────────────────────
// node collect.js --window today [--accounts <accounts.json>]
//   [--fetcher-dir /home/zzw/code/tool/weread-mp-fetcher] [--out <latest.json>]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d = '') => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
  const accountsFile = arg('accounts')
  const accounts = accountsFile ? JSON.parse(readFileSync(accountsFile, 'utf8')).accounts : []
  const win = windowBounds(arg('window', 'today'), arg('tz', 'Asia/Shanghai'))
  try {
    const r = await collect({ fetcherDir: arg('fetcher-dir', '/home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher'), accounts, window: win })
    const out = arg('out')
    if (out) {
      const { mkdirSync, writeFileSync: wf } = await import('node:fs')
      const { dirname, resolve } = await import('node:path')
      mkdirSync(dirname(resolve(out)), { recursive: true })
      wf(out, JSON.stringify(r, null, 2))
    }
    console.log(JSON.stringify({ stats: r.stats, accounts: r.accounts.map((a) => a.name + ':' + a.status + '(' + a.count + ')') }, null, 1))
  } catch (err) {
    console.error('collect failed:', err.message)
    process.exitCode = 1
  }
}
