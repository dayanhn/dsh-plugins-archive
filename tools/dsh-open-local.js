#!/usr/bin/env node
// dsh-open-local.js — the local "opener" behind dsh's headless
// "open with external app". Run it on every machine you want files to
// open ON:
//
//   node dsh-open-local.js
//
// It listens on 127.0.0.1:3900 (loopback only, override with
// DSH_OPEN_PORT). A dsh page viewed from another machine (through an
// ssh tunnel) POSTs the raw file bytes here; this script writes them
// under the OS temp dir and launches the OS default application. It is
// machine-agnostic: it does not know which dsh instance the bytes came
// from and needs no SSH of its own.
//
//   POST /open?filename=NAME   body = raw bytes (application/octet-stream)
//   OPTIONS /open              CORS preflight (the page is cross-origin)
//   GET  /                     health check
//
// Only loopback/private-network page origins are accepted, so a public
// web page cannot drive the opener. Zero dependencies.

'use strict'
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')

const PORT = process.env.DSH_OPEN_PORT ? Number(process.env.DSH_OPEN_PORT) : 3900
const HOST = '127.0.0.1'
// Matches better-sidebar's raw byte-fetch cap.
const MAX_BYTES = 300 * 1024 * 1024
const OUT_ROOT = path.join(os.tmpdir(), 'dsh-open-local')

function privateOriginAllowed(origin) {
  try {
    const host = new URL(origin).hostname
    if (host === 'localhost' || host.startsWith('127.')) return true
    const m = host.match(/^(\d+)\.(\d+)/)
    if (!m) return false
    const a = Number(m[1])
    const b = Number(m[2])
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
  } catch {
    return false
  }
}

// The filename comes from an untrusted browser: keep only the last path
// segment so it cannot escape the temp dir.
function safeName(raw) {
  const name = String(raw || '').split(/[\\/]/).pop()
  if (!name || name === '.' || name === '..') return null
  if (name.length > 200) return null
  if (/[\x00-\x1f]/.test(name)) return null
  return name
}

function launchApp(file) {
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin'
      ? ['open', [file]]
      : ['xdg-open', [file]]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    /* opener died after launch: fire-and-forget, nothing to report */
  })
  child.unref()
}

function sendJson(res, status, obj, origin) {
  const body = JSON.stringify(obj)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  }
  if (origin) headers['access-control-allow-origin'] = origin
  res.writeHead(status, headers)
  res.end(body)
}

const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    res.writeHead(400)
    return res.end()
  }
  const origin = req.headers.origin
  if (origin && !privateOriginAllowed(origin)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }))
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'Origin',
    })
    return res.end()
  }
  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, { ok: true, service: 'dsh-open-local', platform: process.platform, port: PORT }, origin)
  }
  if (req.method !== 'POST' || url.pathname !== '/open') {
    return sendJson(res, 404, { ok: false, error: 'not found' }, origin)
  }
  const name = safeName(url.searchParams.get('filename'))
  if (!name) return sendJson(res, 400, { ok: false, error: 'invalid filename' }, origin)
  const dir = path.join(OUT_ROOT, Date.now().toString(36) + '-' + randomBytes(3).toString('hex'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const out = fs.createWriteStream(file)
  let size = 0
  let settled = false
  const fail = (status, error) => {
    if (settled) return
    settled = true
    out.destroy()
    fs.rm(dir, { recursive: true, force: true }, () => {})
    sendJson(res, status, { ok: false, error }, origin)
  }
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BYTES) return fail(413, `file is over the ${MAX_BYTES} byte cap`)
    if (!out.write(chunk)) req.pause()
  })
  out.on('drain', () => req.resume())
  req.on('end', () => {
    if (settled) return
    out.end(() => {
      if (settled) return
      settled = true
      launchApp(file)
      console.log(`open ${name} -> ${file}`)
      sendJson(res, 200, { ok: true, local: file }, origin)
    })
  })
  req.on('error', () => fail(400, 'request error'))
  out.on('error', (err) => fail(500, String(err.message || err)))
})

server.listen(PORT, HOST, () => {
  console.log(`dsh-open-local: http://${HOST}:${PORT} (platform: ${process.platform}, out: ${OUT_ROOT})`)
})
