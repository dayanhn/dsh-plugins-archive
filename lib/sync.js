// dsh-remote — three-way conflict-aware mirror sync (remote ⇄ local mirror).
//
// Why three-way: plain rsync-style pull/push silently clobbers whichever side
// changed while the other side was edited. We keep a per-mirror snapshot of the
// last-synced remote state (`.dsh-remote-sync-state.json`: relPath →
// {mtime,size}) and compare remote (R), local (L) and last-synced (S):
//
//   R==S && L==S          → unchanged, skip
//   R!=S && L==S          → remote changed → pull it (or push when pushing)
//   R==S && L!=S          → local changed, remote untouched
//                            • pull (rw_sync): would clobber local edit → conflict
//                            • push (rw_push): normal upload
//   R!=S && L!=S && R==L  → both changed to the same bytes → skip
//   R!=S && L!=S && R!=L  → BOTH changed differently → conflict (never clobber)
//
// `force: true` downgrades every conflict to a plain overwrite (rsync behavior).
// `dryRun: true` computes the full plan without writing anything.
// After a successful pull the local mtime is aligned to the remote mtime, and
// after a successful push the local mtime is aligned to the remote mtime the
// server assigned — so the invariant L==R==S holds and the next run is cheap.
//
// Performance:
// - The fast path reuses each entry's {size,mtime} attrs from the SFTP readdir
//   listing: when the last-synced state already matches, no per-file remote
//   stat is issued (the local statSync is on mirror disk, not the wire).
// - Pulls stream SFTP → temp file → rename (fastGet) and pushes stream
//   disk → SFTP (fastPut), so large files never sit fully in memory and a dead
//   transfer cannot leave a half-written file in the mirror.
// - File transfers run in parallel (default 16) and the directory walk is
//   breadth-first with bounded readdir concurrency (default 8) instead of
//   awaiting each subdirectory one at a time — each directory costs a wire
//   round trip, so serial traversal is the dominant cost on multi-hop links.
import { readdirSync, statSync, mkdirSync, existsSync, readFileSync, writeFileSync, utimesSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { joinRemotePath, relPathUnder } from './paths.js'

function mapLimit(items, limit, fn) {
  const limitN = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try { await fn(items[i], i) } catch { /* per-item errors are the fn's concern */ }
    }
  }
  const workers = []
  for (let w = 0; w < limitN; w++) workers.push(worker())
  return Promise.all(workers)
}

const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`
const localKey = (st) => (st ? keyOf(st.size, st.mtimeMs / 1000) : null)
const remoteKey = (st) => (st ? keyOf(st.size, st.mtime) : null)
const isDirEntry = (e) => !!(e.attrs && e.attrs.isDirectory && e.attrs.isDirectory())

// Complete {size,mtime} from the readdir attrs, when the server provided them
// (SFTP directory entries normally carry both; sparse ones fall back to stat).
const entryRemoteKey = (e) =>
  e.attrs && typeof e.attrs.size === 'number' && typeof e.attrs.mtime === 'number' ? remoteKey(e.attrs) : null

/** Recursively pull remote → local mirror (three-way, ignore-aware). */
export async function syncTree(sftp, remoteDir, localDir, opts = {}) {
  const {
    maxDepth = 5,
    maxFiles = 500,
    maxFileBytes = 0,
    isIgnored = () => false,
    dryRun = false,
    force = false,
    state = {},
    concurrency = 16,
    dirConcurrency = 8,
  } = opts
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, conflicts: [], staleRemote: 0, touched: [] }
  const nextState = { ...state }
  // Transfers in flight: parallel workers all pass the top-of-body cap check
  // before any of them completes, so the hard cap counts started+done.
  let inFlight = 0

  const pullFile = async (rDir, lDir, e) => {
    if (stats.files + inFlight >= maxFiles) return
    const name = String(e.filename)
    const rp = joinRemotePath(rDir, name)
    const lp = path.join(lDir, name)
    const rel = relPathUnder(remoteDir, rp) || name
    if (isIgnored(rel, false)) return
    const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
    let r
    const ak = entryRemoteKey(e)
    if (sk && ak === sk) {
      // Fast path: the listing already says the remote file is unchanged since
      // the last sync, so the per-file remote stat is skipped; size/mtime come
      // from the snapshot (identical to what the stat would return).
      r = state[rel]
    } else {
      try { r = await sftp.stat(rp) } catch { return }
    }
    if (maxFileBytes > 0 && r.size > maxFileBytes) { stats.skippedLarge++; return }
    const rk = remoteKey(r)
    let lk = null
    if (existsSync(lp)) {
      try { lk = localKey(statSync(lp)) } catch { lk = null }
    }
    if (sk && rk === sk && lk && lk === sk) { stats.skippedUnchanged++; return }
    if (!force && sk && rk !== sk && lk && lk !== sk && rk !== lk) {
      stats.conflicts.push({ path: rp, reason: 'both-modified（远端与本地都改过，跳过不覆盖）' })
      return
    }
    if (!force && sk && rk === sk && lk && lk !== sk) {
      // Pull would clobber a local edit; the remote never changed.
      stats.conflicts.push({ path: rp, reason: 'local-modified（本地改过而远端未变；如需覆盖请用 force / rw_push）' })
      return
    }
    if (dryRun) {
      stats.files++
      stats.touched.push(rp)
      nextState[rel] = { size: r.size, mtime: r.mtime }
      return
    }
    if (stats.files + inFlight >= maxFiles) return
    inFlight++
    const tmp = lp + '.dsh-remote-tmp'
    try {
      await sftp.fastGet(rp, tmp)
      renameSync(tmp, lp)
    } catch {
      inFlight--
      try { unlinkSync(tmp) } catch {}
      return
    }
    inFlight--
    try { utimesSync(lp, new Date(r.mtime * 1000), new Date(r.mtime * 1000)) } catch {}
    stats.files++
    stats.touched.push(rp)
    nextState[rel] = { size: r.size, mtime: r.mtime }
  }

  // Breadth-first directory walk with bounded readdir concurrency. Every file
  // is only pulled from a directory after that directory is dequeued, and each
  // directory's children are enqueued (parents created) before they are ever
  // pulled — so the file→directory dependency the depth-first version gave
  // serially holds here in parallel. The maxFiles cap is a safety valve, not a
  // selection criterion: BFS pulls breadth-first where DFS pulled depth-first.
  const queue = [{ r: remoteDir, l: localDir, depth: maxDepth }]
  let head = 0
  while (head < queue.length && stats.files < maxFiles) {
    const batch = []
    while (batch.length < dirConcurrency && head < queue.length && stats.files < maxFiles) {
      batch.push(queue[head++])
    }
    await Promise.all(
      batch.map(async ({ r, l, depth }) => {
        let entries
        try { entries = (await sftp.readdir(r)) || [] } catch { return }
        for (const e of entries) {
          const name = String(e.filename)
          if (name === '.' || name === '..' || !isDirEntry(e)) continue
          if (depth <= 0 || stats.files >= maxFiles) continue
          const rp = joinRemotePath(r, name)
          const lp = path.join(l, name)
          const rel = relPathUnder(remoteDir, rp) || name
          if (isIgnored(rel, true)) continue
          if (!existsSync(lp)) mkdirSync(lp, { recursive: true })
          stats.dirs++
          queue.push({ r: rp, l: lp, depth: depth - 1 })
        }
        const files = entries.filter((e) => !isDirEntry(e) && String(e.filename) !== '.' && String(e.filename) !== '..')
        await mapLimit(files, concurrency, (e) => pullFile(r, l, e))
      }),
    )
  }
  // Informational: remote entries in the snapshot that no longer exist remotely.
  for (const rel of Object.keys(state)) {
    if (state[rel] && !nextState[rel]) stats.staleRemote++
  }
  return { stats, nextState }
}

/** Recursively push local mirror → remote (three-way, ignore-aware). */
export async function pushTree(sftp, localDir, remoteDir, opts = {}) {
  const {
    maxFiles = 500,
    maxFileBytes = 0,
    isIgnored = () => false,
    dryRun = false,
    force = false,
    state = {},
    concurrency = 16,
    dirConcurrency = 8,
  } = opts
  const stats = { files: 0, dirs: 0, skippedUnchanged: 0, skippedLarge: 0, conflicts: [], staleLocal: 0, pushed: [] }
  const nextState = { ...state }
  let inFlight = 0

  const pushFile = async (lDir, rDir, e) => {
    if (stats.files + inFlight >= maxFiles) return
    const lp = path.join(lDir, e.name)
    const rp = joinRemotePath(rDir, e.name)
    const rel = relPathUnder(remoteDir, rp) || e.name
    if (isIgnored(rel, false)) return
    let l
    try { l = statSync(lp) } catch { return }
    if (maxFileBytes > 0 && l.size > maxFileBytes) { stats.skippedLarge++; return }
    const lk = localKey(l)
    let r = null
    try { r = await sftp.stat(rp) } catch { /* absent → upload */ }
    const rk = remoteKey(r)
    const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
    if (r && sk && lk === sk && rk === sk) { stats.skippedUnchanged++; return }
    if (r && !force && sk && rk !== sk && lk !== sk && rk !== lk) {
      stats.conflicts.push({ path: rp, reason: 'both-modified（远端与本地都改过，跳过不覆盖）' })
      return
    }
    if (r && !force && sk && rk !== sk && lk === sk) {
      stats.conflicts.push({ path: rp, reason: 'remote-modified（远端改过而本地未变；如需覆盖请用 force / 先 rw_sync）' })
      return
    }
    // Normal case (fall through): local edited since sync, remote untouched → push.
    if (dryRun) {
      stats.files++
      stats.pushed.push(rp)
      return
    }
    if (stats.files + inFlight >= maxFiles) return
    inFlight++
    try {
      await sftp.fastPut(lp, rp)
      // Align local mtime to whatever the remote server assigned, so the
      // L==R==S invariant holds for the next run.
      let r2 = null
      try { r2 = await sftp.stat(rp) } catch {}
      const rmt = r2 ? r2.mtime : Math.floor(Date.now() / 1000)
      try { utimesSync(lp, new Date(rmt * 1000), new Date(rmt * 1000)) } catch {}
      inFlight--
      stats.files++
      stats.pushed.push(rp)
      nextState[rel] = { size: l.size, mtime: rmt }
    } catch {
      inFlight--
      /* skip unwritable */
    }
  }

  const queue = [{ l: localDir, r: remoteDir }]
  let head = 0
  while (head < queue.length && stats.files < maxFiles) {
    const batch = []
    while (batch.length < dirConcurrency && head < queue.length && stats.files < maxFiles) {
      batch.push(queue[head++])
    }
    await Promise.all(
      batch.map(async ({ l, r }) => {
        const entries = readdirSync(l, { withFileTypes: true }).filter(
          (e) => e.name !== '.dsh-remote-meta.json' && e.name !== '.dsh-remote-sync-state.json',
        )
        // Sibling mkdirs in parallel: each is a wire round trip.
        const subdirs = entries.filter((e) => e.isDirectory())
        await mapLimit(subdirs, dirConcurrency, async (e) => {
          if (stats.files >= maxFiles) return
          const rp = joinRemotePath(r, e.name)
          const rel = relPathUnder(remoteDir, rp) || e.name
          if (isIgnored(rel, true)) return
          try { await sftp.mkdir(rp) } catch { /* already exists */ }
          stats.dirs++
          queue.push({ l: path.join(l, e.name), r: rp })
        })
        const files = entries.filter((e) => !e.isDirectory())
        await mapLimit(files, concurrency, (e) => pushFile(l, r, e))
      }),
    )
  }
  for (const rel of Object.keys(state)) {
    if (state[rel] && !nextState[rel]) stats.staleLocal++
  }
  return { stats, nextState }
}

/** Load the sync-state snapshot from a mirror dir (or {}). */
export function loadSyncState(localDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(localDir, '.dsh-remote-sync-state.json'), 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

/** Persist the snapshot (atomic-ish: tmp + rename). */
export function saveSyncState(localDir, state) {
  try {
    mkdirSync(localDir, { recursive: true })
    const tmp = path.join(localDir, '.dsh-remote-sync-state.json.tmp')
    writeFileSync(tmp, JSON.stringify(state, null, 1))
    renameSync(tmp, path.join(localDir, '.dsh-remote-sync-state.json'))
  } catch { /* best effort */ }
}

/** Push ONE local mirror file back to the remote (used by auto-push).
 * Same three-way guard as pushTree: never clobbers a remote change. Returns
 * { status: 'pushed'|'unchanged'|'conflict'|'skipped'|'missing' } and the
 * updated state delta ({rel: {size, mtime}} when pushed). */
export async function pushOneFile(sftp, localDir, remoteDir, rel, opts = {}) {
  const { maxFileBytes = 0, isIgnored = () => false, force = false, state = {} } = opts
  if (isIgnored(rel, false)) return { status: 'skipped' }
  const lp = path.join(localDir, rel.replace(/\//g, path.sep))
  const rp = joinRemotePath(remoteDir, rel)
  let l
  try { l = statSync(lp) } catch { return { status: 'missing' } }
  if (maxFileBytes > 0 && l.size > maxFileBytes) return { status: 'skipped' }
  const lk = localKey(l)
  let r = null
  try { r = await sftp.stat(rp) } catch { /* absent → upload */ }
  const rk = remoteKey(r)
  const sk = state[rel] ? keyOf(state[rel].size, state[rel].mtime) : null
  if (r && sk && lk === sk && rk === sk) return { status: 'unchanged' }
  if (r && !force && sk && rk !== sk && lk !== sk && rk !== lk) {
    return { status: 'conflict', reason: 'both-modified' }
  }
  if (r && !force && sk && rk !== sk && lk === sk) {
    return { status: 'conflict', reason: 'remote-modified' }
  }
  try {
    await sftp.fastPut(lp, rp)
    let r2 = null
    try { r2 = await sftp.stat(rp) } catch {}
    const rmt = r2 ? r2.mtime : Math.floor(Date.now() / 1000)
    try { utimesSync(lp, new Date(rmt * 1000), new Date(rmt * 1000)) } catch {}
    return { status: 'pushed', state: { [rel]: { size: l.size, mtime: rmt } } }
  } catch (e) {
    return { status: 'skipped', error: String((e && e.message) || e) }
  }
}
