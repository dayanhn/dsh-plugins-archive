// dsh-wx-daily — client half.
//
// A 「📮 公众号」 tab in dsh-better-sidebar:
//   • window picker (今天 / 近 3 天 / 近 7 天 / 自定义日期段) + 「⚡ 采集」
//     (server-side: local 微信读书 session → window filter → optional LLM 要点)
//   • aggregated article list, newest first, per-account status chips
//     (double as filters); titles are real links (target _blank)
//   • setup banner while the fetcher / dedicated WeRead Chrome is not ready
// The tab registers through the betterSidebar service (ctx.inject), so the
// client half is a no-op when dsh-better-sidebar is not mounted.
window.__ModuleLoader__.load({
  id: 'dsh-wx-daily',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'dsh-wx-daily'

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

    // ── minimal safe markdown renderer (summary subset) ────────────────────
    // All fetched text is escaped: elements are built with createElement,
    // never innerHTML. Supports: #/##/### headings, ---, > blockquotes,
    // -/1. lists, paragraphs; inline **bold** / [label](url) / `code`.
    function inline(text, keyBase) {
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

    function renderMarkdown(md) {
      const lines = String(md || '').split('\n')
      const els = []
      let i = 0
      let key = 0
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) { i += 1; continue }
        if (line.startsWith('### ')) { els.push(React.createElement('h4', { key: key++, style: { margin: '14px 0 4px', fontSize: 13, fontWeight: 700 } }, inline(line.slice(4), 'h4' + key))); i += 1; continue }
        if (line.startsWith('## ')) { els.push(React.createElement('h3', { key: key++, style: { margin: '16px 0 6px', fontSize: 14, fontWeight: 700 } }, inline(line.slice(3), 'h3' + key))); i += 1; continue }
        if (line.startsWith('# ')) { els.push(React.createElement('h2', { key: key++, style: { margin: '0 0 10px', fontSize: 16, fontWeight: 700 } }, inline(line.slice(2), 'h2' + key))); i += 1; continue }
        if (/^---+$/.test(line.trim())) { els.push(React.createElement('hr', { key: key++, style: { border: 'none', borderTop: '1px solid ' + T.border, margin: '12px 0' } })); i += 1; continue }
        if (line.startsWith('> ')) {
          const q = []
          while (i < lines.length && lines[i].startsWith('> ')) { q.push(lines[i].replace(/^> ?/, '')); i += 1 }
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
        while (i < lines.length && lines[i].trim() && !/^(#|\||> |---|\s*[-*] |\s*\d+\. )/.test(lines[i])) { para.push(lines[i]); i += 1 }
        els.push(React.createElement('p', { key: key++, style: { margin: '6px 0', fontSize: 12.5, lineHeight: 1.6 } }, inline(para.join(' '), 'p' + key)))
      }
      return els
    }

    // ── the tab ─────────────────────────────────────────────────────────────
    const TAB_ID = 'wx-daily-articles'
    const WINDOWS = ['today', '3d', '7d', 'custom']
    const WINDOW_LABELS = { today: '今天', '3d': '近 3 天', '7d': '近 7 天', custom: '自定义' }

    function todayKey(offsetDays) {
      const d = new Date(Date.now() + offsetDays * 86400000)
      return d.toISOString().slice(0, 10)
    }

    function statusMark(a) {
      if (a.status === 'ok') return { text: '✅' + a.count, color: T.ok }
      if (a.status === 'empty') return { text: '—', color: 'inherit', opacity: 0.5 }
      if (a.status === 'nofeed') return { text: '⚠', color: T.warn }
      return { text: '❌', color: T.danger }
    }

    function DailyTab() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [win, setWin] = React.useState('today')
      const [from, setFrom] = React.useState(todayKey(-6))
      const [to, setTo] = React.useState(todayKey(0))
      const [withSummary, setWithSummary] = React.useState(true)
      const [filter, setFilter] = React.useState('')

      const loadLatest = React.useCallback(async () => {
        setBusy('list'); setError('')
        try {
          const [latest, st] = await Promise.all([api('GET', '/wx-daily/latest'), api('GET', '/wx-daily/status')])
          setData(latest.data || null)
          setStatus(st.status || null)
        } catch (e) { setError(String(e.message || e)) }
        setBusy('')
      }, [])
      React.useEffect(() => { loadLatest() }, [loadLatest])

      const doCollect = async () => {
        setBusy('collect'); setError(''); setFilter('')
        try {
          const body = win === 'custom' ? { from, to, withSummary } : { window: win, withSummary }
          const res = await api('POST', '/wx-daily/collect', body)
          setData(res.data || null)
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

      const selStyle = { background: T.bg, color: 'inherit', border: '1px solid ' + T.border, borderRadius: 6, padding: '4px 6px', fontSize: 12 }

      // Setup banners: fetcher checkout missing, or dedicated WeRead Chrome
      // not running, or up but no 公众号 subscribed yet.
      if (status && status.fetcher !== 'ok') {
        return React.createElement('div', { style: { padding: 12, fontSize: 12.5, lineHeight: 1.7 } },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, '📮 公众号'),
          React.createElement('div', { style: { color: T.warn } }, '采集组件未就绪（weread-mp-fetcher 目录缺失）。'),
          React.createElement('div', { style: { marginTop: 6, opacity: 0.8 } },
            '在服务器上 git clone https://github.com/Pengyf04/weread-mp-fetcher 并检查插件配置 fetcherDir，再点「刷新」。'),
          React.createElement('div', { style: { marginTop: 10 } }, btn('刷新状态', loadLatest, busy !== '')))
      }
      if (status && status.fetcher === 'ok' && status.chrome !== 'ok') {
        return React.createElement('div', { style: { padding: 12, fontSize: 12.5, lineHeight: 1.7 } },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, '📮 公众号'),
          React.createElement('div', { style: { color: T.warn } }, '微信读书专用 Chrome 未运行（' + status.chrome + '）。'),
          React.createElement('div', { style: { marginTop: 6, opacity: 0.8 } },
            '直接点「⚡ 采集」会自动拉起（约多等几秒）；手动启动：screen -dmS wereadchrome sh /home/zzw/code/tool/dsh-plugins-archive/weread-mp-fetcher/start-chrome.sh'),
          React.createElement('div', { style: { marginTop: 2, opacity: 0.8 } },
            '首次使用要在那个窗口里打开 weread.qq.com 用微信扫码登录（建议非主微信号）。'),
          React.createElement('div', { style: { marginTop: 10 } }, btn('刷新状态', loadLatest, busy !== '')))
      }
      if (status && status.subscribed === 0) {
        return React.createElement('div', { style: { padding: 12, fontSize: 12.5, lineHeight: 1.7 } },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, '📮 公众号'),
          React.createElement('div', { style: { color: T.warn } }, '还没有订阅任何公众号。'),
          React.createElement('div', { style: { marginTop: 6, opacity: 0.8 } },
            '每个号给一篇它的文章链接（微信里打开文章→分享→复制链接），发给我或 agent 添加，完成后点「刷新」。'),
          React.createElement('div', { style: { marginTop: 10 } }, btn('刷新状态', loadLatest, busy !== '')))
      }

      const accounts = (data && data.accounts) || []
      // it.configName is the accounts.json name the item was collected under
      // (it.account is the wewe-rss feed name, which may differ slightly).
      const items = ((data && data.items) || []).filter((it) => !filter || it.configName === filter)

      return React.createElement('div', { style: { padding: 10, overflow: 'auto', height: '100%' } },
        // header
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' } },
          React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, '📮 公众号'),
          React.createElement('div', { style: { flex: 1 } }),
          React.createElement('select', { value: win, onChange: (e) => setWin(e.target.value), disabled: busy !== '', style: selStyle },
            WINDOWS.map((w) => React.createElement('option', { key: w, value: w }, WINDOW_LABELS[w]))),
          btn(busy === 'collect' ? '⏳ 采集中…' : '⚡ 采集', doCollect, busy !== '', { border: '1px solid ' + T.borderStrong })),
        win === 'custom' ? React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' } },
          React.createElement('input', { type: 'date', value: from, onChange: (e) => setFrom(e.target.value), disabled: busy !== '', style: selStyle }),
          React.createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, '至'),
          React.createElement('input', { type: 'date', value: to, onChange: (e) => setTo(e.target.value), disabled: busy !== '', style: selStyle }),
        ) : null,
        // summary toggle + meta
        React.createElement('div', { style: { display: 'flex', gap: 10, marginBottom: 8, alignItems: 'center', fontSize: 12 } },
          React.createElement('label', { style: { display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer', opacity: 0.85 } },
            React.createElement('input', { type: 'checkbox', checked: withSummary, onChange: (e) => setWithSummary(e.target.checked), disabled: busy !== '' }),
            '含 LLM 摘要'),
          data ? React.createElement('span', { style: { opacity: 0.55 } }, data.window.label + ' · ' + new Date(data.collectedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })) : null),
        // error
        error ? React.createElement('div', { style: { color: T.danger, fontSize: 12, marginBottom: 8 } }, '⚠ ' + error) : null,
        // summary block
        data && data.summary ? React.createElement('div', {
          style: { background: T.bg, border: '1px solid ' + T.border, borderRadius: T.radius, padding: '8px 10px', marginBottom: 10 },
        }, renderMarkdown(data.summary)) : null,
        data && data.summaryError ? React.createElement('div', { style: { fontSize: 11.5, opacity: 0.6, marginBottom: 8 } }, '（摘要：' + data.summaryError + '）') : null,
        // account chips (filter)
        data ? React.createElement('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 } },
          btn('全部', () => setFilter(''), busy !== '', filter === '' ? { borderColor: T.borderStrong } : {}),
          accounts.map((a) => {
            const m = statusMark(a)
            const on = filter === a.name
            return React.createElement('button', {
              key: a.name, type: 'button', title: a.name + (a.error ? '：' + a.error : ''),
              onClick: () => setFilter(on ? '' : a.name), disabled: busy !== '',
              style: { background: on ? T.bg2 : 'transparent', color: 'inherit', border: '1px solid ' + (on ? T.borderStrong : T.border), borderRadius: 10, padding: '1px 8px', fontSize: 11, cursor: 'pointer' },
            }, a.name + ' ', React.createElement('span', { style: { color: m.color, opacity: m.opacity || 1 } }, m.text))
          })) : null,
        // list
        !data && !error ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6, lineHeight: 1.6 } }, '还没有采集记录。选个时间窗点「⚡ 采集」，或在对话里输入 /wx。') : null,
        (busy === 'collect') ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6 } }, '正在通过本机微信读书会话逐号抓取（3 秒/号间隔' + (withSummary ? '，之后生成摘要' : '') + '，约 1~2 分钟）…') : null,
        data && items.length === 0 ? React.createElement('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 8 } }, filter ? '该号在此时间窗内没有文章。' : '该时间窗内没有采集到文章（各号状态见上方 chips）。') : null,
        items.map((it, idx) =>
          React.createElement('div', {
            key: (it.url || '') + '-' + idx,
            style: { padding: '6px 8px', marginBottom: 4, borderRadius: T.radius, background: idx % 2 ? 'transparent' : T.bg, border: '1px solid ' + (idx === 0 ? T.border : 'transparent') },
          },
            React.createElement('a', {
              href: it.url, target: '_blank', rel: 'noreferrer',
              style: { fontSize: 12.5, color: 'inherit', textDecoration: 'none', lineHeight: 1.45, display: 'block' },
            }, it.title),
            React.createElement('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } },
              (it.publishedAt ? it.publishedAt.slice(5, 16).replace('T', ' ') : '—') + ' · ' + it.account)))
      )
    }

    function apply(ctx) {
      ctx.inject(['betterSidebar'], (inner) => {
        const bs = (inner && inner.get && inner.get('betterSidebar')) || null
        if (!bs || typeof bs.registerTab !== 'function') return
        let disposer = null
        try {
          disposer = bs.registerTab({
            id: TAB_ID,
            title: () => '公众号',
            icon: (size) => React.createElement('span', { style: { fontSize: size || 14, lineHeight: 1 } }, '📮'),
            order: 65,
            single: true,
            component: (props) => React.createElement(DailyTab, props),
          })
        } catch (e) {
          console.warn('[dsh-wx-daily] sidebar tab registration skipped:', e)
          return
        }
        inner.effect(() => () => { try { disposer() } catch {} }, 'dsh-wx-daily.sidebar')
      })
    }

    exports.name = name
    exports.apply = apply
    return module.exports
  },
})
