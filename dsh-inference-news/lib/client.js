// dsh-inference-news — client half.
//
// A 「📰 日报」 tab in dsh-better-sidebar:
//   • list of past digests (date + headline preview) from /inference-news/digests
//   • full-text markdown view (safe renderer, no innerHTML on fetched data)
//   • 「⚡ 生成今日日报」→ POST /inference-news/generate (server-side pipeline:
//     collect → LLM curation → digests/YYYY-MM-DD.md)
// The tab registers through the betterSidebar service (ctx.inject), so the
// client half is a no-op when dsh-better-sidebar is not mounted.
window.__ModuleLoader__.load({
  id: 'dsh-inference-news',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'dsh-inference-news'

    async function api(method, p, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(p, opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status)
      return data
    }

    // DSH design tokens so the tab follows the harness light/dark theme.
    const v = (n, fb) => 'var(' + n + ', ' + fb + ')'
    const T = {
      bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      danger: v('--dsw-static-red-500', '#e06c75'),
      ok: v('--dsw-static-green-500', '#4caf7d'),
      warn: v('--dsw-static-yellow-500', '#e6c07b'),
      radius: 8,
    }

    // ── minimal safe markdown renderer (digest subset) ───────────────────────
    // All fetched text is escaped: elements are built with createElement,
    // never innerHTML.
    function inline(text, keyBase) {
      // tokens: **bold**, [label](url), backtick-code
      const out = []
      const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\`([^\`]+)\`/
      let rest = String(text || '')
      let k = 0
      while (rest.length) {
        const m = rest.match(re)
        if (!m || m.index === undefined) { out.push(rest); break }
        if (m.index > 0) out.push(rest.slice(0, m.index))
        if (m[1] !== undefined) out.push(React.createElement('strong', { key: keyBase + '-' + k++ }, m[1]))
        else if (m[2] !== undefined) out.push(React.createElement('a', { key: keyBase + '-' + k++, href: m[3], target: '_blank', rel: 'noreferrer', style: { color: v('--dsw-alias-link-primary', '#6ca0f8') } }, m[2]))
        else if (m[4] !== undefined) out.push(React.createElement('code', { key: keyBase + '-' + k++, style: { background: T.bg2, padding: '0 3px', borderRadius: 3 } }, m[4]))
        rest = rest.slice(m.index + m[0].length)
      }
      return out
    }

    function table(rows) {
      const [head, ...body] = rows
      return React.createElement('table', {
        key: 'tbl',
        style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, margin: '6px 0' },
      },
        React.createElement('thead', null,
          React.createElement('tr', null, head.map((c, i) =>
            React.createElement('th', {
              key: i,
              style: { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid ' + T.borderStrong, color: T.warn, fontWeight: 600 },
            }, inline(c, 'th' + i)))),
        ),
        React.createElement('tbody', null, body.map((r, ri) =>
          React.createElement('tr', { key: ri }, r.map((c, ci) =>
            React.createElement('td', {
              key: ci,
              style: { padding: '4px 8px', borderBottom: '1px solid ' + T.border, verticalAlign: 'top' },
            }, inline(c, 'td' + ri + '-' + ci))),
        ))),
      )
    }

    function renderMarkdown(md) {
      const lines = String(md || '').split('\n')
      const els = []
      let i = 0
      let key = 0
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i += 1; continue }
        if (line.startsWith('<details>')) {
          const inner = []
          i += 1
          let summary = ''
          while (i < lines.length && !lines[i].startsWith('</details>')) {
            const l2 = lines[i]
            const sm = l2.match(/^<summary>([\s\S]*?)<\/summary>/)
            if (sm) { summary = sm[1]; i += 1; continue }
            inner.push(l2)
            i += 1
          }
          i += 1
          els.push(React.createElement('details', {
            key: key++,
            style: { margin: '10px 0', padding: '6px 10px', background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius },
          },
            React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, summary),
            React.createElement('div', null, renderMarkdown(inner.join('\n')))))
          continue
        }
        if (line.startsWith('|')) {
          const rows = []
          while (i < lines.length && lines[i].startsWith('|')) {
            const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim())
            if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells)
            i += 1
          }
          if (rows.length) els.push(table(rows))
          continue
        }
        if (line.startsWith('### ')) { els.push(React.createElement('h4', { key: key++, style: { margin: '14px 0 4px', fontSize: 13, fontWeight: 700 } }, inline(line.slice(4), 'h4' + key))); i += 1; continue }
        if (line.startsWith('## ')) { els.push(React.createElement('h3', { key: key++, style: { margin: '16px 0 6px', fontSize: 14, fontWeight: 700 } }, inline(line.slice(3), 'h3' + key))); i += 1; continue }
        if (line.startsWith('# ')) { els.push(React.createElement('h2', { key: key++, style: { margin: '0 0 10px', fontSize: 16, fontWeight: 700 } }, inline(line.slice(2), 'h2' + key))); i += 1; continue }
        if (/^---+$/.test(line.trim())) { els.push(React.createElement('hr', { key: key++, style: { border: 'none', borderTop: '1px solid ' + T.border, margin: '12px 0' } })); i += 1; continue }
        if (line.startsWith('> ')) {
          const q = []
          while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '> ')) {
            q.push(lines[i].replace(/^> ?/, ''))
            i += 1
          }
          els.push(React.createElement('blockquote', {
            key: key++,
            style: { margin: '8px 0', padding: '8px 12px', borderLeft: '3px solid ' + T.borderStrong, background: T.bg, borderRadius: 4, fontSize: 12.5, lineHeight: 1.6 },
          }, renderMarkdown(q.join('\n'))))
          continue
        }
        if (/^\s*[-*] /.test(line) || /^\s*\d+\. /.test(line)) {
          const items = []
          while (i < lines.length && (/^\s*[-*] /.test(lines[i]) || /^\s*\d+\. /.test(lines[i]))) {
            const text = lines[i].replace(/^\s*(-|\d+\.) ?/, '')
            items.push(React.createElement('li', { key: items.length, style: { margin: '3px 0' } }, inline(text, 'li' + key + '-' + items.length)))
            i += 1
          }
          els.push(React.createElement('ul', { key: key++, style: { margin: '6px 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.55 } }, items))
          continue
        }
        const para = [line]
        i += 1
        while (i < lines.length && lines[i].trim() && !/^(#|\||> |---|<details>|\s*[-*] |\s*\d+\. )/.test(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        els.push(React.createElement('p', { key: key++, style: { margin: '6px 0', fontSize: 12.5, lineHeight: 1.6 } }, inline(para.join(' '), 'p' + key)))
      }
      return els
    }

    // ── the tab ──────────────────────────────────────────────────────────────
    const TAB_ID = 'inference-news-daily'

    function DailyTab() {
      const [list, setList] = React.useState([])
      const [view, setView] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')

      const loadList = React.useCallback(async () => {
        setBusy('list'); setError('')
        try {
          const data = await api('GET', '/inference-news/digests')
          setList(data.digests || [])
        } catch (e) { setError(String(e.message || e)) }
        setBusy('')
      }, [])
      React.useEffect(() => { loadList() }, [loadList])

      const openDay = async (date) => {
        setBusy('md'); setError('')
        try {
          const data = await api('GET', '/inference-news/digests/' + date)
          setView({ date: data.date, markdown: data.markdown })
        } catch (e) { setError(String(e.message || e)) }
        setBusy('')
      }

      const generate = async () => {
        setBusy('gen'); setError('')
        try {
          await api('POST', '/inference-news/generate', {})
          await loadList()
          const latest = list.length ? list[0].date : ''
          if (latest) openDay(latest)
        } catch (e) { setError(String(e.message || e)) }
        setBusy('')
      }

      const btn = (label, onClick, disabled, style) => React.createElement('button', {
        type: 'button',
        onClick,
        disabled,
        style: Object.assign({
          background: T.bg2,
          color: 'inherit',
          border: '1px solid ' + T.border,
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }, style || {}),
      }, label)

      if (view) {
        return React.createElement('div', { style: { padding: 10, overflow: 'auto', height: '100%' } },
          React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' } },
            btn('← 返回列表', () => setView(null), false),
            React.createElement('span', { style: { fontSize: 12, opacity: 0.7 } }, view.date)),
          React.createElement('div', null, renderMarkdown(view.markdown)))
      }

      return React.createElement('div', { style: { padding: 10, overflow: 'auto', height: '100%' } },
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '📰 推理日报'),
          React.createElement('div', { style: { flex: 1 } }),
          btn(busy === 'gen' ? '⏳ 生成中…' : '⚡ 生成今日日报', generate, busy !== '', { border: '1px solid ' + T.borderStrong })),
        error ? React.createElement('div', { style: { color: T.danger, fontSize: 12, marginBottom: 8 } }, '⚠ ' + error) : null,
        busy === 'list' ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6 } }, '加载中…') : null,
        !busy && list.length === 0 && !error ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.6 } }, '还没有日报。点「⚡ 生成今日日报」开始，或等待每日 09:00 的定时任务。') : null,
        list.map((d, idx) =>
          React.createElement('div', {
            key: d.date,
            onClick: () => openDay(d.date),
            style: {
              padding: '8px 10px',
              marginBottom: 6,
              borderRadius: T.radius,
              background: idx === 0 ? T.bg2 : T.bg,
              border: '1px solid ' + (idx === 0 ? T.borderStrong : T.border),
              cursor: 'pointer',
            },
          },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 600 } },
              React.createElement('span', null, d.date + (idx === 0 ? ' · 今日' : '')),
              React.createElement('span', { style: { opacity: 0.55, fontWeight: 400 } }, (d.size / 1024).toFixed(1) + ' KB')),
            (d.headlines || []).slice(0, 2).map((h, i) =>
              React.createElement('div', { key: i, style: { fontSize: 11.5, opacity: 0.8, marginTop: 3, lineHeight: 1.45 } }, (i + 1) + '. ' + h)))),
        busy === 'gen' ? React.createElement('div', { style: { fontSize: 11.5, opacity: 0.6, marginTop: 6, lineHeight: 1.5 } }, '采集 30+ 源 + LLM 筛选，通常 2–5 分钟…') : null)
    }

    function apply(ctx) {
      ctx.inject(['betterSidebar'], (inner) => {
        const bs = (inner && inner.get && inner.get('betterSidebar')) || null
        if (!bs || typeof bs.registerTab !== 'function') return
        let disposer = null
        try {
          disposer = bs.registerTab({
            id: TAB_ID,
            title: () => '日报',
            icon: (size) => React.createElement('span', { style: { fontSize: size || 14, lineHeight: 1 } }, '📰'),
            order: 60,
            single: true,
            component: (props) => React.createElement(DailyTab, props),
          })
        } catch (e) {
          console.warn('[dsh-inference-news] sidebar tab registration skipped:', e)
          return
        }
        inner.effect(() => () => { try { disposer() } catch {} }, 'dsh-inference-news.sidebar')
      })
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
