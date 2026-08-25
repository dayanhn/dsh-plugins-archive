#!/usr/bin/env node
/**
 * inference-news M0 collector. Zero dependencies (Node >= 18 global fetch).
 *
 * Modes:
 *   node collect.mjs --out <candidates.json> [--age-hours 72] [--state <seen.json>]
 *       Fetches arXiv / GitHub releases / blog RSS / Hacker News, scores items
 *       against inference keywords, dedupes URLs against the state file, and
 *       writes a candidate list for model curation.
 *   node collect.mjs --update-seen <digest.md> --state <seen.json>
 *       Extracts every URL from a published digest, records them in the state
 *       file (pruned to 30 days), so the next run does not re-report them.
 *
 * Source failures are isolated: each source reports its own status and the
 * run still succeeds with the remaining sources.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { parse as urlParse } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration (M0 constants; M1 moves these into a cordis.yml Config)
// ---------------------------------------------------------------------------

const ARXIV = {
  endpoint: 'https://export.arxiv.org/api/query',
  categories: ['cs.LG', 'cs.CL', 'cs.DC', 'cs.AR'],
  maxResults: 200,
};

const GITHUB_REPOS = [
  // core inference engines
  'vllm-project/vllm',
  'vllm-project/vllm-ascend',
  'vllm-project/llm-compressor',
  'sgl-project/sglang',
  'NVIDIA/TensorRT-LLM',
  'InternLM/lmdeploy',
  'huggingface/text-generation-inference',
  'mlc-ai/mlc-llm',
  'ggml-org/llama.cpp',
  'ollama/ollama',
  'modeltc/lightllm',
  'ai-dynamo/dynamo',
  // KV cache / disaggregation / memory
  'kvcache-ai/Mooncake',
  'LMCache/LMCache',
  // DeepSeek
  'deepseek-ai/DeepSeek-V3',
  // Huawei Ascend: CANN / MindIE / MindSpeed / framework adapters
  'Ascend/MindIE-LLM',
  'Ascend/MindIE-Motor',
  'Ascend/MindSpeed-LLM',
  'Ascend/pytorch',
  'Ascend/cann-container-image',
  'Ascend/triton-ascend',
  'Ascend/sglang',
  'mindspore-ai/mindspore',
];

// tier: 'focused' = inference-specific feed, every in-window item passes the
// gate; 'general' = broad tech feed, items must score >= 2 against keywords.
// pytorch.org is unreachable from this host without a proxy; hf-mirror is the
// mainland-CN mirror of huggingface.co.
const RSS_FEEDS = [
  { name: 'vLLM Blog', url: 'https://blog.vllm.com.cn/feed.xml', tier: 'focused' },
  { name: 'Meituan Tech', url: 'https://tech.meituan.com/feed/', tier: 'focused' },
  { name: 'Interconnects', url: 'https://www.interconnects.ai/feed', tier: 'focused' },
  { name: 'Hugging Face Blog (hf-mirror)', url: 'https://hf-mirror.com/blog/feed.xml', tier: 'focused' },
  { name: 'NVIDIA Developer Blog', url: 'https://developer.nvidia.com/blog/feed/', tier: 'focused' },
  { name: 'QbitAI', url: 'https://www.qbitai.com/feed', tier: 'general' },
  { name: 'InfoQ China', url: 'https://www.infoq.cn/feed', tier: 'general' },
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', tier: 'general' },
  { name: 'Azure Blog', url: 'https://azure.microsoft.com/en-us/blog/feed/', tier: 'general' },
  { name: 'Databricks Blog', url: 'https://databricks.com/blog/feed.xml', tier: 'general' },
  { name: 'NVIDIA Corporate Blog', url: 'https://blogs.nvidia.com/feed', tier: 'general' },
];

// HF Daily Papers via the mainland-CN mirror; the paper list is curated
// trending (50/day) and carries ai_keywords for the relevance gate.
const HF_DAILY_PAPERS = 'https://hf-mirror.com/api/daily_papers';

const HN_QUERIES = ['LLM inference', 'vLLM', 'speculative decoding', 'KV cache', 'sglang'];
const HN_MIN_POINTS = 25;

const FETCH_TIMEOUT_MS = 25_000;
const USER_AGENT = 'inference-news-collector/0.1 (dsh daily digest)';
const SNIPPET_CHARS = 400;
const MAX_ITEMS = 120;

// Keyword gate: [regex, weight]. Score = sum of weights of distinct matches.
// Papers pass at score >= 2; tracked-repo releases always pass; focused-tier
// blog feeds pass every in-window item while general-tier feeds need score
// >= 2; HN stories pass at score >= 2 or high points.
const KEYWORDS = [
  [/(kv[ -]?cache)/i, 3],
  [/speculative[ -]?decod/i, 3],
  [/disaggregat/i, 3],
  [/(prefill)/i, 2],
  [/(continuous[ -]?batch|batching)/i, 2],
  [/(vllm)/i, 3],
  [/(sglang)/i, 3],
  [/(tensorrt[ -]?llm)/i, 3],
  [/(lmdeploy)/i, 3],
  [/(mindie)/i, 3],
  [/(vllm-ascend|ascend[ -]npu|npu)/i, 2],
  [/(paged[ -]?attention|flash[ -]?attention)/i, 2],
  [/(inference[ -]?engine|serving[ -]?engine|inference[ -]?serving|llm[ -]?serving)/i, 3],
  [/(quantiz)/i, 2],
  [/(\bMoE\b|mixture[ -]of[ -]?experts)/i, 2],
  [/(throughput)/i, 1.5],
  [/(latency|TTFT|TPOT)/i, 1.5],
  [/(inference)/i, 1],
  [/(large[ -]?language[ -]?model|\bLLM\b)/i, 1],
  [/(attention)/i, 1],
  [/(\bkernel(s)?\b)/i, 1],
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function unCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function field(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? unCdata(decodeEntities(m[1])).replace(/\s+/g, ' ').trim() : '';
}

function fieldHref(block, tag) {
  const m = block.match(new RegExp('<' + tag + '\\s[^>]*?href="([^"]+)"', 'i'));
  return m ? m[1] : '';
}

function truncate(s, n) {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------------------------------------------------------------------------
// Scoring / dedupe / state
// ---------------------------------------------------------------------------

function scoreItem(text) {
  let score = 0;
  const matched = [];
  for (const [re, w] of KEYWORDS) {
    if (re.test(text)) {
      score += w;
      matched.push(re.source);
    }
  }
  return { score: Math.round(score * 10) / 10, matched };
}

function stripTracking(u) {
  const q = u.indexOf('?');
  if (q < 0) return u;
  const base = u.slice(0, q);
  const keep = u
    .slice(q + 1)
    .split('&')
    .filter((p) => {
      const k = (p.split('=')[0] || '').toLowerCase();
      return k !== '' && !/^utm_/.test(k) && !['ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(k);
    });
  return keep.length > 0 ? base + '?' + keep.join('&') : base;
}

function normUrl(u) {
  let out = decodeEntities(u).trim().replace(/[.,;:!?)\]'"]+$/, '').replace(/#.*$/, '').replace(/\/$/, '');
  out = out.replace(/^http:\/\/arxiv\.org/i, 'https://arxiv.org');
  if (/arxiv\.org\/abs\//i.test(out)) out = out.replace(/v\d+$/, '');
  const i = out.indexOf('://');
  if (i > 0) out = out.slice(0, i) + '://' + stripTracking(out.slice(i + 3));
  return out.toLowerCase();
}

function loadState(path) {
  if (!path || !existsSync(path)) return new Map();
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    return new Map(Object.entries(obj));
  } catch (err) {
    console.error(`warning: unreadable state file ${path}: ${err.message}; starting empty`);
    return new Map();
  }
}

function saveState(path, map) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(map), null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function proxyFromEnv() {
  const v = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY || '';
  if (!/^https?:\/\//i.test(v)) return null; // M0: plain-HTTP proxies only (no socks)
  const p = urlParse(v);
  return { host: p.hostname, port: Number(p.port) || 80, user: p.username || '', pass: p.password || '' };
}

function noProxyHit(host) {
  const np = process.env.no_proxy || process.env.NO_PROXY || '';
  return np
    .split(',')
    .map((s) => s.trim().replace(/^\.\//, '').replace(/^\./, ''))
    .filter(Boolean)
    .some((e) => e === host || host.endsWith('.' + e));
}

async function fetchViaProxy(url, proxy, hop = 0) {
  const u = urlParse(url);
  const port = Number(u.port) || 443;
  const sock = await new Promise((res, rej) => {
    const s = netConnect({ host: proxy.host, port: proxy.port }, () => res(s));
    s.once('error', rej);
  });
  const auth = proxy.user ? 'Proxy-Authorization: Basic ' + Buffer.from(proxy.user + ':' + proxy.pass).toString('base64') + '\r\n' : '';
  sock.write('CONNECT ' + u.hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + u.hostname + ':' + port + '\r\n' + auth + '\r\n');
  const head = await new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('proxy CONNECT timeout')), 10000);
    const onData = (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        clearTimeout(timer);
        sock.removeListener('data', onData);
        res({ statusLine: buf.split('\r\n')[0], rest: buf.slice(i + 4) });
      }
    };
    sock.on('data', onData);
    sock.once('error', (e) => { clearTimeout(timer); rej(e); });
  });
  if (!/HTTP\/1\.[01] 2\d\d/.test(head.statusLine)) {
    sock.destroy();
    throw new Error('proxy CONNECT rejected: ' + head.statusLine);
  }
  const secure = tlsConnect({ socket: sock, servername: u.hostname });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('proxy TLS timeout')), 10000);
    secure.once('secureConnect', () => { clearTimeout(timer); res(); });
    secure.once('error', (e) => { clearTimeout(timer); rej(e); });
  });
  const path = (u.pathname || '/') + (u.search || '');
  secure.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + u.hostname + '\r\nUser-Agent: ' + USER_AGENT + '\r\nAccept: */*\r\nConnection: close\r\n\r\n');
  const data = await new Promise((res, rej) => {
    let all = head.rest;
    secure.on('data', (d) => { all += d.toString('latin1'); });
    secure.once('end', () => res(all));
    secure.once('error', rej);
  });
  secure.destroy();
  const idx = data.indexOf('\r\n\r\n');
  if (idx < 0) throw new Error('proxy: malformed response');
  const headPart = data.slice(0, idx);
  let bodyPart = data.slice(idx + 4);
  const status = Number(headPart.split(' ')[1]);
  const location = (headPart.match(/location: (.+)/i) || [])[1];
  const clen = headPart.match(/content-length: (\d+)/i);
  if (/transfer-encoding: chunked/i.test(headPart)) {
    let out = '';
    let rest = bodyPart;
    while (rest.length) {
      const lineEnd = rest.indexOf('\r\n');
      if (lineEnd < 0) break;
      const size = Number.parseInt(rest.slice(0, lineEnd), 16);
      if (!size) break;
      out += rest.slice(lineEnd + 2, lineEnd + 2 + size);
      rest = rest.slice(lineEnd + 2 + size + 2);
    }
    bodyPart = out;
  } else if (clen) {
    bodyPart = bodyPart.slice(0, Number(clen[1]));
  }
  if (status >= 300 && status < 400 && location) {
    if (hop > 3) throw new Error('too many redirects via proxy');
    return fetchViaProxy(new URL(location.trim(), url).toString(), proxy, hop + 1);
  }
  if (status < 200 || status >= 300) throw new Error('HTTP ' + status);
  return Buffer.from(bodyPart, 'latin1').toString('utf8');
}

const proxyFailedHosts = new Set();

async function fetchText(url) {
  const proxy = proxyFromEnv();
  const u = urlParse(url);
  if (proxy && u.protocol === 'https:' && !noProxyHit(u.hostname) && !proxyFailedHosts.has(u.hostname)) {
    try {
      return await fetchViaProxy(url, proxy);
    } catch (err) {
      proxyFailedHosts.add(u.hostname);
      console.error('note: proxy fetch failed for ' + u.hostname + ' (' + err.message + '); falling back to direct');
    }
  }
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: 'application/xml, application/atom+xml, application/rss+xml, application/json, text/xml, */*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function fetchArxiv(sinceHours) {
  const fmt = (d) => d.toISOString().slice(0, 16).replace(/[-:T]/g, ''); // YYYYMMDDHHMM
  const start = new Date(Date.now() - sinceHours * 3600e3);
  const q = `(${ARXIV.categories.map((c) => 'cat:' + c).join(' OR ')}) AND submittedDate:[${fmt(start)} TO ${fmt(new Date())}]`;
  const url = `${ARXIV.endpoint}?search_query=${encodeURIComponent(q)}&start=0&max_results=${ARXIV.maxResults}&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchText(url);
  const items = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const id = field(block, 'id');
    if (!id) continue;
    const authors = [...block.matchAll(/<name>([^<]+)<\/name>/g)].slice(0, 3).map((a) => a[1]);
    const cat = (block.match(/<category term="([^"]+)"/) || [])[1] || '';
    items.push({
      kind: 'paper',
      source: 'arXiv',
      title: field(block, 'title'),
      url: id,
      publishedAt: field(block, 'published'),
      authors,
      category: cat,
      snippet: truncate(field(block, 'summary'), SNIPPET_CHARS),
    });
  }
  return items;
}

async function fetchGithub(repo, sinceHours) {
  const xml = await fetchText(`https://github.com/${repo}/releases.atom`);
  const cutoff = Date.now() - sinceHours * 3600e3;
  const items = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const href = fieldHref(block, 'link');
    const updated = field(block, 'updated');
    if (!href || !updated || Date.parse(updated) < cutoff) continue;
    const tag = (href.match(/releases\/tag\/([^/?"\s]+)/) || [])[1] || '';
    items.push({
      kind: 'release',
      source: `GitHub:${repo}`,
      title: `${repo} ${field(block, 'title') || tag}`,
      url: href,
      tag,
      publishedAt: updated,
      snippet: truncate(stripHtml(field(block, 'content')), SNIPPET_CHARS),
    });
  }
  return items;
}

async function fetchRss(feed, sinceHours) {
  const xml = await fetchText(feed.url);
  const cutoff = Date.now() - sinceHours * 3600e3;
  const isAtom = /<entry[\s>]/.test(xml) && !/<item[\s>]/.test(xml);
  const blockRe = isAtom ? /<entry>([\s\S]*?)<\/entry>/g : /<item>([\s\S]*?)<\/item>/g;
  const items = [];
  for (const m of xml.matchAll(blockRe)) {
    const block = m[1];
    const link = isAtom ? fieldHref(block, 'link') || field(block, 'id') : field(block, 'link');
    const date = field(block, 'pubDate') || field(block, 'dc:date') || field(block, 'updated') || field(block, 'published');
    const t = date ? Date.parse(date) : NaN;
    if (!link || Number.isNaN(t) || t < cutoff) continue;
    const body = field(block, 'description') || field(block, 'content:encoded') || field(block, 'content') || field(block, 'summary');
    items.push({
      kind: 'blog',
      source: feed.name,
      tier: feed.tier || 'general',
      title: field(block, 'title'),
      url: link,
      publishedAt: date,
      snippet: truncate(stripHtml(body), SNIPPET_CHARS),
    });
  }
  return items;
}

async function fetchDailyPapers() {
  const data = JSON.parse(await fetchText(HF_DAILY_PAPERS));
  const items = [];
  for (const entry of data) {
    const p = entry.paper || entry;
    const id = p.id || '';
    const title = p.title || entry.title || '';
    if (!id || !title) continue;
    const kw = p.ai_keywords;
    const kwStr = Array.isArray(kw) ? kw.join(', ') : String(kw || '');
    items.push({
      kind: 'paper',
      source: 'HF Daily Papers',
      tier: 'general',
      title,
      url: 'https://arxiv.org/abs/' + id,
      publishedAt: p.publishedAt || entry.publishedAt || '',
      authors: (p.authors || []).slice(0, 3).map((a) => (a && a.name) || a),
      upvotes: p.upvotes || 0,
      snippet: truncate((p.summary || entry.summary || '') + (kwStr ? ' | keywords: ' + kwStr : ''), SNIPPET_CHARS),
    });
  }
  return items;
}

async function fetchHn(query, sinceHours) {
  const cutoff = Math.floor(Date.now() / 1000 - sinceHours * 3600);
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i%3E${cutoff}&hitsPerPage=15`;
  const data = JSON.parse(await fetchText(url));
  const items = [];
  for (const h of data.hits || []) {
    if ((h.points || 0) < HN_MIN_POINTS) continue;
    items.push({
      kind: 'community',
      source: `HackerNews:${query}`,
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points,
      comments: h.num_comments,
      publishedAt: new Date(/^(\\d+)$/.test(String(h.created_at)) ? Number(h.created_at) * 1000 : Date.parse(h.created_at) || Date.now()).toISOString(),
      snippet: truncate(h.story_text ? stripHtml(h.story_text) : '', SNIPPET_CHARS),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const CONCURRENCY = 4;
const RETRY_DELAY_MS = 1500;

/**
 * Retry a flaky source fetch: up to 3 attempts. HTTP 429 (arXiv rate
 * limiting after a busy morning of runs) gets a 4x backoff and keeps it for
 * the next attempt; other failures use the base delay.
 * @param delayMs base delay in ms (tests inject a tiny value).
 */
async function withRetry(fn, attempt = 1, delayMs = RETRY_DELAY_MS) {
  try {
    return await fn();
  } catch (err) {
    if (attempt >= 3) throw err;
    const throttled = /HTTP 429|rate.?limit/i.test(String((err && err.message) || err));
    const delay = throttled ? delayMs * 4 : delayMs;
    await new Promise((r) => setTimeout(r, delay));
    return await withRetry(fn, attempt + 1, delay);
  }
}

async function mapPool(entries, limit, fn) {
  const results = new Array(entries.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= entries.length) return;
      results[i] = await fn(entries[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, () => worker()));
  return results;
}

async function runSource(name, fn) {
  const t0 = Date.now();
  try {
    const items = await fn();
    return { name, status: 'ok', fetched: items.length, ms: Date.now() - t0, items };
  } catch (err) {
    return { name, status: 'error', error: String(err.message || err), ms: Date.now() - t0, items: [] };
  }
}

async function collect(args) {
  if (!args.out) throw new Error('--out is required in collect mode');
  const sinceHours = args.ageHours;
  const state = loadState(args.state);
  const now = Date.now();
  const recent = (url) => {
    const key = normUrl(url);
    const seenAt = state.get(key);
    if (!seenAt) return false;
    return now - Date.parse(seenAt) <= 14 * 86400e3;
  };

  const jobs = [
    ['arXiv', () => withRetry(() => fetchArxiv(sinceHours))],
    ['HF Daily Papers', () => withRetry(() => fetchDailyPapers())],
    ...GITHUB_REPOS.map((repo) => ['GitHub:' + repo, () => withRetry(() => fetchGithub(repo, sinceHours))]),
    ...RSS_FEEDS.map((feed) => [feed.name, () => withRetry(() => fetchRss(feed, sinceHours))]),
    ...HN_QUERIES.map((query) => ['HackerNews:' + query, () => withRetry(() => fetchHn(query, sinceHours))]),
  ];
  const results = await mapPool(jobs, CONCURRENCY, (job) => runSource(job[0], job[1]));

  const seenKeys = new Set();
  let items = [];
  for (const r of results) {
    for (const it of r.items) {
      const key = normUrl(it.url);
      if (!key || seenKeys.has(key) || recent(it.url)) continue;
      seenKeys.add(key);
      const { score, matched } = scoreItem([it.title, it.snippet, it.category || ''].join(' '));
      const pass =
        (it.kind === 'paper' && score >= 2) ||
        it.kind === 'release' ||
        (it.kind === 'blog' && (it.tier === 'focused' || score >= 2)) ||
        (it.kind === 'community' && (score >= 2 || it.points >= 100));
      if (!pass) continue;
      items.push({ ...it, score, matched });
    }
  }
  // Release-flood collapse: repos shipping many builds a day (llama.cpp b#####,
  // LMCache nightlies) keep only their best in-window release per repo.
  const bestRelease = new Map();
  for (const it of items) {
    if (it.kind !== 'release') continue;
    const prev = bestRelease.get(it.source);
    if (!prev || it.score > prev.score || (it.score === prev.score && Date.parse(it.publishedAt) > Date.parse(prev.publishedAt))) {
      bestRelease.set(it.source, it);
    }
  }
  // re-merge: non-releases in original order + one release per repo
  const merged = [];
  for (const it of items) {
    if (it.kind !== 'release') merged.push(it);
  }
  for (const [, it] of bestRelease) {
    merged.push(it);
  }
  items = merged;
  items.sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  items = items.slice(0, MAX_ITEMS);

  const out = {
    generatedAt: new Date().toISOString(),
    windowHours: sinceHours,
    sources: results.map(({ name, status, error, fetched, ms }) => ({ name, status, error, fetched, ms })),
    itemCount: items.length,
    items,
  };
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(out, null, 2) + '\n');

  // stdout summary
  for (const r of results) {
    console.log(`${r.status === 'ok' ? '✅' : '❌'} ${r.name}: ${r.status === 'ok' ? `${r.fetched} items (${r.ms}ms)` : r.error}`);
  }
  console.log(`→ ${items.length} candidates written to ${args.out}`);
  for (const it of items.slice(0, 10)) {
    console.log(`  [${it.kind}] (score ${it.score}) ${it.title} — ${it.url}`);
  }
  return out;
}

function updateSeen(args) {
  if (!args.updateSeen || !args.state) throw new Error('--update-seen and --state are required');
  const text = readFileSync(args.updateSeen, 'utf8');
  const state = loadState(args.state);
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const m of text.matchAll(/https?:\/\/[^)\]\s>"'，。、；]+/g)) {
    const key = normUrl(m[0]);
    if (!key || state.has(key)) continue;
    state.set(key, today);
    added += 1;
  }
  const cutoff = Date.now() - 30 * 86400e3;
  for (const [key, date] of [...state.entries()]) {
    if (Date.parse(date) < cutoff) state.delete(key);
  }
  saveState(args.state, state);
  console.log(`→ ${added} new URLs recorded in ${args.state} (total ${state.size}, kept 30d)`);
}


// ── module exports (plugin + tests) ─────────────────────────────────────────
export {
  collect as runCollect,
  updateSeen as recordSeen,
  withRetry,
  scoreItem,
  normUrl,
  stripTracking,
  KEYWORDS,
  GITHUB_REPOS,
  RSS_FEEDS,
  HN_QUERIES,
  ARXIV,
};
