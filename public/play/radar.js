// LUSCA Radar player (X player card). /play/radar plays the newest catches from the cached /api/radar list;
// /play/radar/:id plays one catch, before → after, from the cached /api/radar/:id. Stored events only: no
// websocket, no RPC from viewers. Polls only while the player is on screen and stops after 20 visible minutes.
;(() => {
  'use strict'
  const POLL_MS = 6000
  const ONE_MS = 30000
  const MAX_VISIBLE_MS = 20 * 60 * 1000
  const $ = (id) => document.getElementById(id)
  const st = $('st')
  const m = /^\/play\/radar\/([a-z]{3}-[a-z0-9]{6,20})\/?$/.exec(location.pathname)
  const ONE = m ? m[1] : null

  function fit() {
    const s = Math.min(window.innerWidth / 480, window.innerHeight / 480)
    st.style.transform = `scale(${s > 0 ? s : 1})`
  }
  window.addEventListener('resize', fit)
  fit()

  let docVisible = document.visibilityState !== 'hidden'
  let onScreen = true
  document.addEventListener('visibilitychange', () => { docVisible = document.visibilityState !== 'hidden'; if (visible()) kick() })
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); if (visible()) kick() }, { threshold: 0.1 }).observe(st)
  }
  const visible = () => docVisible && onScreen
  let visibleMs = 0
  let stopped = false

  // ── helpers ──
  const fmt = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '—')
  const short = (a, n = 4) => (typeof a === 'string' && a.length > 2 * n + 3 ? `${a.slice(0, n + (a.startsWith('0x') ? 2 : 0))}…${a.slice(-n)}` : a ? String(a) : '—')
  const hash = (h) => (typeof h === 'string' && h.length > 16 ? `${h.replace(/^0x/, '').slice(0, 8)}…${h.slice(-4)}` : h || '—')
  const CHAIN = { solana: 'SOL', ethereum: 'ETH', base: 'BASE', arbitrum: 'ARB' }
  const KIND = { upgrade: 'upgraded', deploy: 'deployed', admin_change: 'admin changed', beacon_upgrade: 'beacon upgraded', authority_change: 'authority changed', close: 'closed' }
  const VER = { osec: 'OtterSec', 'sourcify-full': 'Sourcify full', 'sourcify-partial': 'Sourcify partial', none: 'not verified', unknown: 'unknown' }
  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 172800 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
  }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? fmt(v) : '—')

  // before → after rows: only fields at least one side knows
  function rowsOf(e) {
    const b = e.before || {}, a = e.after || {}, d = e.diff || {}
    const evm = e.chain !== 'solana'
    const R = []
    const has = (k) => b[k] != null || a[k] != null
    if (evm && has('implementation')) R.push(['implementation', short(b.implementation), short(a.implementation), (b.implementation || '') !== (a.implementation || '')])
    if (evm && has('beacon') && R.length < 1) R.push(['beacon', short(b.beacon), short(a.beacon), (b.beacon || '') !== (a.beacon || '')])
    if (!evm || has('authority')) R.push([evm ? 'proxy admin' : 'upgrade authority', b.authority ? short(b.authority) : e.before ? (b.upgradeable === false ? 'none' : '—') : '—', a.authority ? short(a.authority) : a.upgradeable === false ? 'none · immutable' : '—', d.authority === 'changed'])
    R.push(['code hash', hash(b.codeHash), hash(a.codeHash), d.code === 'changed'])
    if (has('surfaceCount')) R.push([evm ? 'functions' : 'instructions', num(b.surfaceCount), num(a.surfaceCount), b.surfaceCount != null && a.surfaceCount != null && b.surfaceCount !== a.surfaceCount])
    if (evm && has('guardCount')) R.push(['admin-only', num(b.guardCount), num(a.guardCount), b.guardCount != null && a.guardCount != null && b.guardCount !== a.guardCount])
    if (R.length < 5 && (b.verified || a.verified)) R.push(['verified', e.before ? VER[b.verified] || '—' : '—', VER[a.verified] || '—', d.verified === 'changed'])
    if (R.length < 5 && has('bytes')) R.push([evm ? 'bytecode' : 'program bytes', num(b.bytes), num(a.bytes), b.bytes != null && a.bytes != null && b.bytes !== a.bytes])
    return R.slice(0, 5)
  }

  // the boxed line: a new admin-only function (file:line) or, failing that, what else changed
  function boxOf(e) {
    const d = e.diff || {}
    const g = (d.guardsAdded || [])[0]
    if (g) return { k: 'new admin-only function', n: d.guardsAdded.length > 1 ? `+${d.guardsAdded.length - 1} more` : '', fn: g.fn, at: [g.guard, g.at] }
    const c = (d.guardsChanged || [])[0]
    if (c) return { k: 'access check changed', n: '', fn: c.fn, at: [`${c.before.guard} → ${c.after.guard}`, c.after.at] }
    const r = (d.guardsRemoved || [])[0]
    if (r) return { k: 'access check removed', n: '', fn: r.fn, at: [`was ${r.guard}`, r.at] }
    const add = d.added && d.added.items && d.added.items[0]
    if (add) return { k: `${d.surface === 'instructions' ? 'instruction' : 'function'} added`, n: d.added.items.length + d.added.more > 1 ? `+${d.added.items.length + d.added.more - 1} more` : '', fn: add, at: null }
    const pa = (d.primitivesAdded || [])[0]
    if (pa) return { k: 'primitive added', n: '', fn: pa, at: null }
    if (e.proxies && e.proxies.n > 1) return { k: 'proxies in this deploy', n: '', fn: `${fmt(e.proxies.n)} proxies`, at: [`first ${short(e.proxies.sample && e.proxies.sample[0])}`, e.via] }
    return null
  }

  // ── playback ──
  let cur = null
  const history = []

  function start(e) {
    const plan = []
    const rows = rowsOf(e)
    const box = boxOf(e)
    const rowsEl = $('rows'), gd = $('gd'), sweep = $('sweep')
    plan.push({ at: 0, run: () => {
      const chip = $('chain'); chip.textContent = CHAIN[e.chain] || e.chain; chip.className = 'chip' + (e.chain === 'solana' ? ' sol' : '')
      $('kind').textContent = KIND[e.kind] || e.kind
      $('ago').textContent = ago(e.ts)
      const nm = $('name')
      nm.textContent = e.name || short(e.address, 6)
      nm.className = 'nm typing' + (e.name ? '' : ' addr')
      $('addr').textContent = e.proxies && e.proxies.n > 1 ? `first proxy ${e.address}` : e.address
      const hl = $('hl'); hl.textContent = e.headline || ''; hl.classList.remove('in'); void hl.offsetWidth; hl.classList.add('in')
      rowsEl.textContent = ''; gd.className = 'gd mono'; gd.textContent = ''
      document.querySelector('.ba-h span:nth-child(2)').textContent = e.before ? 'before' : 'before · none'
      for (const [k, b, a, chg] of rows) {
        const r = el('div', 'r' + (chg ? ' chg' : ''))
        r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'b', b)); r.appendChild(el('span', 'ar', '→')); r.appendChild(el('span', 'a', a))
        rowsEl.appendChild(r)
      }
      const bl = $('blip'); bl.setAttribute('cx', String(Math.round(Math.cos(e.ts % 6.28) * 26))); bl.setAttribute('cy', String(Math.round(Math.sin(e.ts % 6.28) * 26)))
      bl.classList.remove('on'); void bl.getBoundingClientRect(); bl.classList.add('on')
      if (ONE) $('out').href = `https://lusca.ink/lens/${e.chain}/${e.address}`
      if (ONE) $('out').textContent = `lens · ${short(e.address)} ↗`
    } })
    let t = 650
    rows.forEach((_, i) => plan.push({ at: t + i * 130, run: () => { const r = rowsEl.children[i]; if (r) r.querySelector('.b').classList.add('in') } }))
    t += rows.length * 130 + 250
    plan.push({ at: t, run: () => { sweep.classList.remove('go'); void sweep.offsetWidth; sweep.classList.add('go'); $('name').classList.remove('typing') } })
    rows.forEach((_, i) => plan.push({ at: t + 120 + i * 120, run: () => { const r = rowsEl.children[i]; if (r) { r.querySelector('.ar').classList.add('in'); r.querySelector('.a').classList.add('in') } } }))
    t += 120 + rows.length * 120 + 350
    if (box) {
      plan.push({ at: t, run: () => {
        const k = el('div', 'k'); k.appendChild(el('span', '', box.k)); k.appendChild(el('span', '', box.n)); gd.appendChild(k)
        gd.appendChild(el('div', 'fn', box.fn))
        if (box.at) { const at = el('div', 'at'); at.appendChild(el('b', '', box.at[0] || '')); if (box.at[1]) at.appendChild(document.createTextNode(` · ${box.at[1]}`)); gd.appendChild(at) }
        gd.classList.add('in')
      } })
      t += 600
    }
    if (ONE) plan.push({ at: t, run: () => detail(e) })
    const hold = ONE ? 7000 : queue.length > 2 ? 3200 : 5200
    cur = { e, plan, t: 0, i: 0, dur: t + hold }
  }

  // one catch: added / removed lists and where it was caught
  function detail(e) {
    const more = $('more'); more.textContent = ''
    const d = e.diff || {}
    const add = (d.added && d.added.items) || [], rem = (d.removed && d.removed.items) || []
    if (add.length || rem.length) {
      more.appendChild(el('div', 'lab', `${d.surface || 'surface'} · ${add.length + ((d.added && d.added.more) || 0)} added · ${rem.length + ((d.removed && d.removed.more) || 0)} removed`))
      const ls = el('div', 'lists')
      const a = el('div'), r = el('div')
      add.slice(0, 3).forEach((x, i) => { const li = el('div', 'li add', x); li.style.animationDelay = `${i * 90}ms`; a.appendChild(li) })
      rem.slice(0, 3).forEach((x, i) => { const li = el('div', 'li rem', x); li.style.animationDelay = `${i * 90}ms`; r.appendChild(li) })
      ls.appendChild(a); ls.appendChild(r); more.appendChild(ls)
    } else more.appendChild(el('div', 'lab', e.state === 'pending' ? 'being read' : 'no surface difference read'))
    const f = el('div', 'facts')
    const bits = []
    if (e.block) bits.push(['block', fmt(e.block)]); else if (e.slot) bits.push(['slot', fmt(e.slot)])
    if (e.tx) bits.push(['tx', short(e.tx, 6)])
    if (e.actor) bits.push([e.actorRole || 'by', short(e.actor)])
    bits.push(['via', String(e.via || '').replace(/\s*\(backfill\)$/, '')])
    bits.forEach(([k, v], i) => { if (i) f.appendChild(document.createTextNode(' · ')); f.appendChild(document.createTextNode(`${k} `)); f.appendChild(el('b', '', v)) })
    more.appendChild(f)
  }

  function renderHistory() {
    if (ONE) return
    const more = $('more'); more.textContent = ''
    more.appendChild(el('div', 'lab', history.length ? 'earlier catches' : ''))
    history.slice(0, 3).forEach((e, i) => {
      const r = el('div', 'tick'); r.style.animationDelay = `${i * 70}ms`
      r.appendChild(el('span', 'c', CHAIN[e.chain] || e.chain))
      const tx = el('span', 't'); tx.appendChild(el('b', '', e.name || short(e.address))); tx.appendChild(document.createTextNode(String(e.headline || '').split(' · ').slice(0, 3).join(' · '))); r.appendChild(tx)
      r.appendChild(el('span', 'w', ago(e.ts)))
      more.appendChild(r)
    })
  }

  function waitMsg(text) {
    $('name').textContent = text; $('name').className = 'nm wait'
  }

  // ── feed queue: new catches jump in; with nothing new, the latest ones replay (with their real times) ──
  const queue = []
  const seen = new Map() // id → updatedAt
  let list = []
  let ring = 0
  function enqueue(items) {
    list = items
    const fresh = items.filter((e) => e && e.id && (!seen.has(e.id) || seen.get(e.id) !== e.updatedAt) && seen.size > 0)
    if (!seen.size) queue.push(...items.slice(0, 4).reverse())
    else for (const e of fresh.slice(0, 4).reverse()) { queue.unshift(e) }
    for (const e of items) seen.set(e.id, e.updatedAt)
    if (seen.size > 400) { const keep = [...seen].slice(-200); seen.clear(); keep.forEach(([k, v]) => seen.set(k, v)) }
    while (queue.length > 6) queue.pop()
  }
  function next() {
    if (queue.length) return queue.shift()
    if (!list.length) return null
    ring = (ring + 1) % Math.min(list.length, 8)
    return list[ring]
  }

  let last = performance.now()
  function frame(now) {
    const dt = Math.min(100, now - last)
    last = now
    if (visible() && !stopped) {
      visibleMs += dt
      if (visibleMs > MAX_VISIBLE_MS) pause()
      if (cur) {
        cur.t += dt
        while (cur.i < cur.plan.length && cur.plan[cur.i].at <= cur.t) cur.plan[cur.i++].run()
        if (cur.t >= cur.dur) {
          if (ONE) start(cur.e)
          else { const n = next(); if (n) { if (n.id !== cur.e.id) { history.unshift(cur.e); while (history.length > 3) history.pop(); const ix = history.findIndex((h, i) => i > 0 && h.id === cur.e.id); if (ix > 0) history.splice(ix, 1) } start(n); renderHistory() } else cur.t = 0 }
        }
      } else if (!ONE) { const n = next(); if (n) { start(n); renderHistory() } }
      if (cur) $('ago').textContent = ago(cur.e.ts)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ── data ──
  let pollTimer = 0
  let backoff = ONE ? ONE_MS : POLL_MS
  let etag = ''
  let have = false
  async function poll() {
    pollTimer = 0
    if (stopped || !visible()) return
    try {
      const url = ONE ? `/api/radar/${ONE}` : '/api/radar?limit=12'
      const r = await fetch(url, { cache: 'no-cache', headers: etag ? { 'If-None-Match': etag } : {} })
      if (r.status === 304) backoff = ONE ? ONE_MS : POLL_MS
      else if (r.ok) {
        etag = r.headers.get('ETag') || ''
        const j = await r.json()
        if (ONE) {
          const changed = !cur || cur.e.updatedAt !== j.updatedAt
          if (changed) start(j)
          have = true
          backoff = ONE_MS
          if (j.state !== 'pending') { schedule(0, true); return } // read: nothing more will change
        } else {
          const items = Array.isArray(j.items) ? j.items.filter((e) => e && e.id) : []
          if (!items.length && !have) waitMsg('no catches stored yet')
          if (items.length) have = true
          enqueue(items)
          const s = j.status && j.status.last24h
          if (s) $('count').textContent = `${fmt(s.total)} changes · 24 h`
          backoff = POLL_MS
        }
      } else {
        if (r.status === 404 && ONE) { waitMsg('no radar event with this id'); stopped = true; st.classList.add('still'); return }
        if (r.status === 503 && !have) waitMsg('the radar is not running here')
        backoff = Math.min(60000, backoff * 2)
      }
    } catch { backoff = Math.min(60000, backoff * 2) }
    schedule(backoff)
  }
  function schedule(ms, never) {
    if (never) { done = true; st.classList.add('still'); $('live').textContent = 'CAUGHT'; return }
    if (pollTimer || stopped) return
    pollTimer = setTimeout(poll, ms)
  }
  let done = false
  function kick() { if (!pollTimer && !stopped && !(ONE && have && done)) schedule(0) }
  function pause() {
    stopped = true
    if (pollTimer) clearTimeout(pollTimer)
    st.classList.add('paused')
    $('live').textContent = 'PAUSED'
  }
  if (ONE) { $('live').textContent = 'CATCH'; $('count').textContent = ONE }
  kick()
})()
