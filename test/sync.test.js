// sync.js behavior tests over a fake in-memory SFTP + real temp-dir mirrors.
// The fake counts wire operations so tests can assert the fast path (readdir
// attrs reused, no per-file stat on the second sync) and the transfer path
// (fastGet/fastPut, not readFile/writeFile).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync, existsSync, rmSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncTree, pushTree, pushOneFile, loadSyncState, saveSyncState } from '../lib/sync.js'

const T0 = 1_700_000_000 // fixed baseline mtime (s)

/** In-memory remote tree. dir = SFTP root; keys are remote paths under it. */
function makeFakeSftp(initial = {}) {
  const tree = new Map() // p → { isDir, size, mtime, content }
  const calls = { readdir: 0, stat: 0, mkdir: 0, fastGet: 0, fastPut: 0, readFile: 0, writeFile: 0 }
  const failGet = new Set()

  const addDir = (p) => {
    const norm = p.replace(/\/+$/, '')
    if (!norm) return
    if (!tree.has(norm)) tree.set(norm, { isDir: true, size: 4096, mtime: T0, content: '' })
    const i = norm.lastIndexOf('/')
    if (i >= 0) addDir(norm.slice(0, i))
  }
  const addFile = (p, mtime, content) => {
    addDir(p.slice(0, p.lastIndexOf('/')))
    tree.set(p, { isDir: false, size: Buffer.byteLength(content), mtime, content })
  }
  for (const [p, m] of Object.entries(initial)) addFile(p, m.mtime, m.content)

  const dirOf = (p) => {
    const i = p.lastIndexOf('/')
    return i <= 0 ? '' : p.slice(0, i)
  }
  const attrs = (e) => ({ size: e.size, mtime: e.mtime, isDirectory: () => e.isDir })

  return {
    calls,
    failGet,
    tree,
    // test mutators
    setRemote(p, mtime, content) { addFile(p, mtime, content) },
    delRemote(p) { tree.delete(p) },
    // sftp adapter surface used by sync.js
    async readdir(dir) {
      calls.readdir++
      await new Promise((r) => setTimeout(r, 1))
      const d = dir.replace(/\/+$/, '')
      const e = tree.get(d)
      if (!e || !e.isDir) throw new Error('no such directory: ' + dir)
      const prefix = d ? d + '/' : ''
      const out = []
      for (const [p, ee] of tree) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        out.push({ filename: rest, attrs: attrs(ee) })
      }
      return out
    },
    async stat(p) {
      calls.stat++
      await new Promise((r) => setTimeout(r, 1))
      const e = tree.get(p.replace(/\/+$/, ''))
      if (!e) throw new Error('no such file: ' + p)
      return { size: e.size, mtime: e.mtime }
    },
    async mkdir(dir) {
      calls.mkdir++
      const d = dir.replace(/\/+$/, '')
      if (tree.has(d)) throw new Error('File exists')
      addDir(d)
    },
    async fastGet(remote, local) {
      calls.fastGet++
      await new Promise((r) => setTimeout(r, 2))
      if (failGet.has(remote)) throw new Error('injected get failure')
      const e = tree.get(remote)
      if (!e || e.isDir) throw new Error('no such file: ' + remote)
      writeFileSync(local, e.content)
    },
    async fastPut(local, remote) {
      calls.fastPut++
      await new Promise((r) => setTimeout(r, 2))
      addFile(remote, Math.floor(Date.now() / 1000), readFileSync(local, 'utf8'))
    },
    async readFile(p) {
      calls.readFile++
      const e = tree.get(p)
      if (!e || e.isDir) throw new Error('no such file: ' + p)
      return e.content
    },
  }
}

function localDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-sync-test-'))
}
const localOf = (local, rel) => path.join(local, ...rel.split('/'))
const alignMtime = (p, mtimeS) => utimesSync(p, new Date(mtimeS * 1000), new Date(mtimeS * 1000))

test('first sync pulls all files; second sync is all-unchanged with ZERO remote stats (fast path)', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({
    '/data/a.txt': { mtime: T0, content: 'alpha' },
    '/data/sub/b.txt': { mtime: T0 + 1, content: 'beta' },
    '/data/sub/deep/c.txt': { mtime: T0 + 2, content: 'gamma' },
  })
  const local = localDir()
  try {
    const r1 = await syncTree(sftp, remote, local, { state: {} })
    assert.equal(r1.stats.files, 3)
    assert.equal(r1.stats.conflicts.length, 0)
    assert.equal(readFileSync(localOf(local, 'a.txt'), 'utf8'), 'alpha')
    assert.equal(readFileSync(localOf(local, 'sub/b.txt'), 'utf8'), 'beta')
    assert.equal(readFileSync(localOf(local, 'sub/deep/c.txt'), 'utf8'), 'gamma')
    // mtime aligned to remote
    assert.equal(Math.floor(statSync(localOf(local, 'a.txt')).mtimeMs / 1000), T0)
    assert.equal(sftp.calls.fastGet, 3)
    assert.equal(sftp.calls.stat, 3) // first run: no state → authoritative stat

    // Second run: state matches → fast path off the readdir attrs.
    sftp.calls.stat = 0
    sftp.calls.fastGet = 0
    const r2 = await syncTree(sftp, remote, local, { state: r1.nextState })
    assert.equal(r2.stats.files, 0)
    assert.equal(r2.stats.skippedUnchanged, 3)
    assert.equal(sftp.calls.stat, 0)
    assert.equal(sftp.calls.fastGet, 0)
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('remote change is pulled; local-only change is a conflict; force overrides', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({ '/data/f.txt': { mtime: T0, content: 'v1' } })
  const local = localDir()
  try {
    const r1 = await syncTree(sftp, remote, local, { state: {} })
    assert.equal(r1.stats.files, 1)

    // Remote changed, local untouched → pull.
    sftp.setRemote('/data/f.txt', T0 + 10, 'v2')
    const r2 = await syncTree(sftp, remote, local, { state: r1.nextState })
    assert.equal(r2.stats.files, 1)
    assert.equal(readFileSync(localOf(local, 'f.txt'), 'utf8'), 'v2')

    // Local changed only → conflict, NOT overwritten.
    const fp = localOf(local, 'f.txt')
    writeFileSync(fp, 'local-edit')
    alignMtime(fp, T0 + 20)
    const r3 = await syncTree(sftp, remote, local, { state: r2.nextState })
    assert.equal(r3.stats.files, 0)
    assert.equal(r3.stats.conflicts.length, 1)
    assert.match(r3.stats.conflicts[0].reason, /local-modified/)
    assert.equal(readFileSync(fp, 'utf8'), 'local-edit')

    // force → remote wins.
    const r4 = await syncTree(sftp, remote, local, { state: r2.nextState, force: true })
    assert.equal(r4.stats.files, 1)
    assert.equal(r4.stats.conflicts.length, 0)
    assert.equal(readFileSync(fp, 'utf8'), 'v2')

    // Both modified differently → conflict.
    sftp.setRemote('/data/f.txt', T0 + 30, 'v3')
    writeFileSync(fp, 'local-again')
    alignMtime(fp, T0 + 40)
    const r5 = await syncTree(sftp, remote, local, { state: r4.nextState })
    assert.equal(r5.stats.files, 0)
    assert.equal(r5.stats.conflicts.length, 1)
    assert.match(r5.stats.conflicts[0].reason, /both-modified/)
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('local file deleted in the mirror is recreated on pull', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({ '/data/f.txt': { mtime: T0, content: 'here' } })
  const local = localDir()
  try {
    const r1 = await syncTree(sftp, remote, local, { state: {} })
    const fp = localOf(local, 'f.txt')
    rmSync(fp)
    const r2 = await syncTree(sftp, remote, local, { state: r1.nextState })
    assert.equal(r2.stats.files, 1)
    assert.equal(readFileSync(fp, 'utf8'), 'here')
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('sparse readdir attrs fall back to per-file stat (still correct)', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({ '/data/f.txt': { mtime: T0, content: 'x' } })
  const local = localDir()
  try {
    const r1 = await syncTree(sftp, remote, local, { state: {} })
    // Strip attrs from the listing → fast path unavailable.
    const orig = sftp.readdir.bind(sftp)
    sftp.readdir = async (d) => (await orig(d)).map((e) => ({ filename: e.filename, attrs: { isDirectory: () => false } }))
    sftp.calls.stat = 0
    const r2 = await syncTree(sftp, remote, local, { state: r1.nextState })
    assert.equal(r2.stats.skippedUnchanged, 1)
    assert.equal(r2.stats.files, 0)
    assert.equal(sftp.calls.stat, 1) // authoritative stat used
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('maxFileBytes skips large files; maxDepth bounds the walk; isIgnored prunes', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({
    '/data/big.bin': { mtime: T0, content: 'B'.repeat(1024) },
    '/data/small.txt': { mtime: T0, content: 's' },
    '/data/d1/d2/d3/deep.txt': { mtime: T0, content: 'deep' },
    '/data/node_modules/pkg/index.js': { mtime: T0, content: 'pkg' },
    '/data/.git/config': { mtime: T0, content: 'git' },
  })
  const local = localDir()
  try {
    const r = await syncTree(sftp, remote, local, {
      state: {},
      maxDepth: 1,
      maxFileBytes: 100,
      isIgnored: (rel) => rel.startsWith('node_modules') || rel.startsWith('.git'),
    })
    assert.equal(r.stats.files, 1) // only small.txt (big over cap; deep over depth; ignored pruned)
    assert.equal(r.stats.skippedLarge, 1)
    assert.ok(existsSync(localOf(local, 'small.txt')))
    assert.ok(!existsSync(localOf(local, 'big.bin')))
    assert.ok(!existsSync(localOf(local, 'd1/d2/d3/deep.txt')))
    assert.ok(!existsSync(localOf(local, 'node_modules/pkg/index.js')))
    assert.ok(!existsSync(localOf(local, '.git/config')))
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('dryRun plans without writing files or state', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({ '/data/f.txt': { mtime: T0, content: 'x' } })
  const local = localDir()
  try {
    const r = await syncTree(sftp, remote, local, { state: {}, dryRun: true })
    assert.equal(r.stats.files, 1)
    assert.deepEqual(r.stats.touched, ['/data/f.txt'])
    assert.ok(!existsSync(localOf(local, 'f.txt')))
    assert.equal(sftp.calls.fastGet, 0)
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('a failing fastGet leaves no partial file and no tmp residue', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({
    '/data/bad.txt': { mtime: T0, content: 'bad' },
    '/data/good.txt': { mtime: T0, content: 'good' },
  })
  sftp.failGet.add('/data/bad.txt')
  const local = localDir()
  try {
    const r = await syncTree(sftp, remote, local, { state: {} })
    assert.equal(r.stats.files, 1)
    assert.ok(!existsSync(localOf(local, 'bad.txt')))
    assert.ok(!existsSync(localOf(local, 'bad.txt.dsh-remote-tmp')))
    assert.equal(readFileSync(localOf(local, 'good.txt'), 'utf8'), 'good')
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('maxFiles caps transfers without breaking the walk', async () => {
  const remote = '/data'
  const files = {}
  for (let i = 0; i < 12; i++) files[`/data/d${i % 3}/f${i}.txt`] = { mtime: T0 + i, content: `c${i}` }
  const sftp = makeFakeSftp(files)
  const local = localDir()
  try {
    const r = await syncTree(sftp, remote, local, { state: {}, maxFiles: 5 })
    assert.equal(r.stats.files, 5)
    assert.equal(sftp.calls.fastGet, 5)
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('state file round-trips through the mirror dir', () => {
  const local = localDir()
  try {
    assert.deepEqual(loadSyncState(local), {})
    const state = { 'a/b.txt': { size: 3, mtime: T0 } }
    saveSyncState(local, state)
    assert.deepEqual(loadSyncState(local), state)
    assert.ok(!existsSync(path.join(local, '.dsh-remote-sync-state.json.tmp')))
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('pushTree: uploads changed local files, skips unchanged, detects remote-modified conflict', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({ '/data/keep.txt': { mtime: T0, content: 'same' } })
  const local = localDir()
  try {
    // Seed a matching local mirror: keep.txt (unchanged) + new.txt (to upload) + sub/ (dir creation).
    writeFileSync(localOf(local, 'keep.txt'), 'same')
    alignMtime(localOf(local, 'keep.txt'), T0)
    writeFileSync(localOf(local, 'new.txt'), 'upload-me')
    mkdirSync(localOf(local, 'sub'), { recursive: true })
    writeFileSync(localOf(local, 'sub/nested.txt'), 'nested')
    const state = { 'keep.txt': { size: 4, mtime: T0 } }

    const r = await pushTree(sftp, local, remote, { state })
    assert.equal(r.stats.files, 2) // new.txt + sub/nested.txt
    assert.equal(r.stats.skippedUnchanged, 1)
    assert.equal(sftp.calls.fastPut, 2)
    assert.equal(sftp.tree.get('/data/new.txt').content, 'upload-me')
    assert.equal(sftp.tree.get('/data/sub/nested.txt').content, 'nested')
    assert.ok(sftp.tree.get('/data/sub').isDir)

    // Remote changed behind our back while local unchanged → conflict.
    sftp.setRemote('/data/new.txt', T0 + 5, 'remote-won')
    const r2 = await pushTree(sftp, local, remote, { state: r.nextState })
    assert.equal(r2.stats.files, 0)
    assert.equal(r2.stats.conflicts.length, 1)
    assert.match(r2.stats.conflicts[0].reason, /remote-modified/)
    assert.equal(sftp.tree.get('/data/new.txt').content, 'remote-won')

    // force → local overwrites.
    const r3 = await pushTree(sftp, local, remote, { state: r2.nextState, force: true })
    assert.equal(r3.stats.files, 1)
    assert.equal(sftp.tree.get('/data/new.txt').content, 'upload-me')
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('pushOneFile: pushed / unchanged / missing / both-modified conflict', async () => {
  const remote = '/data'
  const sftp = makeFakeSftp({ '/data/f.txt': { mtime: T0, content: 'remote-v1' } })
  const local = localDir()
  try {
    const fp = localOf(local, 'f.txt')
    writeFileSync(fp, 'local-v1')
    alignMtime(fp, T0)
    const state = { 'f.txt': { size: 8, mtime: T0 } }

    // Unchanged (local & remote both match the snapshot).
    sftp.setRemote('/data/f.txt', T0, 'local-v1')
    assert.equal((await pushOneFile(sftp, local, remote, 'f.txt', { state })).status, 'unchanged')

    // Local edited, remote untouched → push.
    writeFileSync(fp, 'local-v2')
    alignMtime(fp, T0 + 7)
    const pushed = await pushOneFile(sftp, local, remote, 'f.txt', { state })
    assert.equal(pushed.status, 'pushed')
    assert.equal(sftp.tree.get('/data/f.txt').content, 'local-v2')
    assert.ok(pushed.state['f.txt'].size === 8)

    // Both modified differently → conflict, remote preserved.
    sftp.setRemote('/data/f.txt', T0 + 3, 'remote-v3')
    writeFileSync(fp, 'local-v3')
    alignMtime(fp, T0 + 9)
    const conflict = await pushOneFile(sftp, local, remote, 'f.txt', { state: pushed.state })
    assert.equal(conflict.status, 'conflict')
    assert.equal(conflict.reason, 'both-modified')
    assert.equal(sftp.tree.get('/data/f.txt').content, 'remote-v3')

    // Missing local file.
    assert.equal((await pushOneFile(sftp, local, remote, 'nope.txt', { state })).status, 'missing')
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})

test('parallel transfers: many files across many directories all land', async () => {
  const remote = '/data'
  const initial = {}
  for (let d = 0; d < 6; d++) {
    for (let f = 0; f < 10; f++) initial[`/data/dir${d}/file${f}.txt`] = { mtime: T0 + f, content: `d${d}f${f}` }
  }
  const sftp = makeFakeSftp(initial)
  const local = localDir()
  try {
    const r = await syncTree(sftp, remote, local, { state: {} })
    assert.equal(r.stats.files, 60)
    for (let d = 0; d < 6; d++) {
      for (let f = 0; f < 10; f++) {
        assert.equal(readFileSync(localOf(local, `dir${d}/file${f}.txt`), 'utf8'), `d${d}f${f}`)
      }
    }
    assert.equal(readdirSync(local).length, 6)
  } finally {
    rmSync(local, { recursive: true, force: true })
  }
})
