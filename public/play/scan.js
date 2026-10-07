// LUSCA Scan player (X player card). Plays the chain agents' real reads, call by call, from the cached
// /api/chain/feed?scan=1 endpoint (no websocket: thousands of feed viewers must never touch the hub that
// carries contributors' jobs). Polls only while the player is on screen and stops after 20 visible minutes.
;(() => {
  'use strict'
  const POLL_MS = 4000
  const STATS_MS = 30000
  const MAX_VISIBLE_MS = 20 * 60 * 1000
  const $ = (id) => document.getElementById(id)
  const st = $('st')

  // ── fit the fixed 480 x 480 stage into whatever box X gives the iframe ──
  function fit() {
    const s = Math.min(window.innerWidth / 480, window.innerHeight / 480)
    st.style.transform = `scale(${s > 0 ? s : 1})`
  }
  window.addEventListener('resize', fit)
  fit()

  // ── visibility: rAF clock only advances while visible; polling only while visible ──
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
  const short = (a, n = 4) => (typeof a === 'string' && a.length > 2 * n + 3 ? `${a.slice(0, n + (a.startsWith('0x') ? 2 : 0))}…${a.slice(-n)}` : String(a ?? ''))
  const CHAIN = { solana: 'SOL', ethereum: 'ETH', base: 'BASE', arbitrum: 'ARB' }
  const isPublic = (p) => /public/i.test(String(p ?? ''))
  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
  }
  // which provider node a call lights up (0 Helius / Solana RPC, 1 EVM RPC, 2 Sourcify, 3 OtterSec)
  function nodeOf(read, call) {
    const p = String(call.provider ?? call.method ?? '')
    if (/sourcify/i.test(p)) return 2
    if (/ottersec|osec/i.test(p)) return 3
    return read.chain === 'solana' ? 0 : 1
  }
  function providerLabel(read, call) {
    const p = String(call.provider ?? '')
    if (!p || isPublic(p) || /publicnode/i.test(p)) return read.chain === 'solana' ? 'Solana RPC' : `${CHAIN[read.chain] ?? ''} RPC`
    return p
  }
  function fieldsOf(r) {
    const s = r.scan || {}
    const f = []
    if (r.chain === 'solana') {
      if (s.loader) f.push(['loader', s.loader + (s.upgradeable === false ? ' · immutable' : '')])
      if (s.authority !== undefined) f.push(['upgrade authority', s.authority ? short(s.authority, 6) : 'none · immutable'])
      if (s.programBytes) f.push(['program size', `${fmt(s.programBytes)} bytes`])
      if (s.idl && s.idl.name) f.push(['anchor idl', `${s.idl.name}${s.idl.instructions ? ` · ${s.idl.instructions.length} ix` : ''}`])
      else if (s.codeHash) f.push(['code hash', short(s.codeHash, 8)])
      if (Array.isArray(s.primitives) && s.primitives.length && f.length < 4) f.push(['primitives', s.primitives[0]])
      if (s.deploySlot && f.length < 4) f.push(['deploy slot', fmt(s.deploySlot)])
    } else {
      if (s.verified && s.verified.by) f.push(['verified', `${s.verified.by} ${s.verified.match ?? ''}`.trim()])
      if (s.bytecodeBytes) f.push(['bytecode', `${fmt(s.bytecodeBytes)} bytes`])
      const pv = s.privileged && Array.isArray(s.privileged.items) ? s.privileged.items : []
      if (pv.length) f.push(['admin-only', `${pv[0].fn} · ${pv[0].guard}`.slice(0, 60)])
      if (s.abi && Array.isArray(s.abi.names)) f.push(['abi', `${fmt(s.abi.names.length + (s.abi.more || 0))} functions`])
      if (s.files && Array.isArray(s.files.paths) && f.length < 4) f.push(['source files', fmt(s.files.paths.length + (s.files.more || 0))])
      if (s.codeHash && f.length < 4) f.push(['code hash', short(s.codeHash, 8)])
      if (s.verified && s.verified.compiler && f.length < 4) f.push(['compiler', String(s.verified.compiler).split('+')[0]])
    }
    return f.slice(0, 4)
  }
  const VERDICT = { kept: 'KEPT', unverified: 'REJECTED', boilerplate: 'REJECTED', duplicate: 'REJECTED', 'not-code': 'REJECTED', 'token-mint': 'REJECTED', error: 'ERROR' }

  // ── playback: one real read at a time, a few seconds behind live ──
  const queue = []
  const seen = new Set()
  let cur = null // { read, plan: [{at, run}], t, dur, i }
  let lastTs = 0

  function enqueue(reads) {
    const fresh = reads.filter((r) => r && r.id && !seen.has(r.id) && r.ts > lastTs).sort((a, b) => a.ts - b.ts)
    for (const r of fresh) { seen.add(r.id); queue.push(r); lastTs = Math.max(lastTs, r.ts) }
    if (seen.size > 600) { const keep = [...seen].slice(-300); seen.clear(); keep.forEach((k) => seen.add(k)) }
    while (queue.length > 8) queue.shift() // fall behind no more than a handful of reads
  }

  function lightNode(i) {
    for (let k = 0; k < 4; k++) {
      $(`n${k}`).classList.toggle('on', k === i)
      $(`w${k}`).classList.toggle('on', k === i)
    }
  }

  function start(read) {
    const plan = []
    const callsEl = $('calls'), fieldsEl = $('fields'), vd = $('verdict')
    // target
    plan.push({ at: 0, run: () => {
      callsEl.textContent = ''; fieldsEl.textContent = ''; lightNode(-1)
      const chip = $('chain'); chip.textContent = CHAIN[read.chain] ?? read.chain; chip.className = 'chip' + (read.chain === 'solana' ? ' sol' : '')
      $('kind').textContent = `${read.kind === 'program' ? 'program' : read.kind === 'contract' ? 'contract' : read.kind ?? 'address'} · ${read.agent ?? ''}`
      $('ago').textContent = `read ${ago(read.ts)}`
      const nm = $('name')
      nm.textContent = read.name || short(read.address, read.chain === 'solana' ? 6 : 6)
      nm.className = 'nm typing' + (read.name ? '' : ' addr')
      $('addr').textContent = read.address
      vd.className = 'vd mono'; vd.querySelector('#vtext')?.remove()
      while (vd.childNodes.length > 1) vd.removeChild(vd.lastChild)
      vd.appendChild(el('span', 'dim', 'reading…'))
    } })
    // calls, spaced so each one can be seen
    const calls = Array.isArray(read.trace) ? read.trace.slice(0, 3) : []
    let t = 700
    calls.forEach((c) => {
      const row = { node: null }
      const dur = Math.min(1400, Math.max(500, Number(c.ms) || 500))
      plan.push({ at: t, run: () => {
        lightNode(nodeOf(read, c))
        const d = el('div', 'call')
        const l1 = el('div', 'l1')
        l1.appendChild(el('i', 'st'))
        l1.appendChild(el('b', '', c.method ?? 'call'))
        l1.appendChild(el('span', 'dim', c.target ? String(c.target).slice(0, 28) : ''))
        const pv = providerLabel(read, c)
        l1.appendChild(el('span', 'pv' + (/helius/i.test(pv) ? ' hl' : ''), pv))
        const ms = el('span', 'ms', '…'); l1.appendChild(ms)
        d.appendChild(l1)
        const l2 = el('div', 'l2', ' '); d.appendChild(l2)
        callsEl.appendChild(d)
        while (callsEl.children.length > 3) callsEl.removeChild(callsEl.firstChild)
        row.node = { d, ms, l2 }
      } })
      plan.push({ at: t + dur, run: () => {
        if (!row.node) return
        row.node.d.classList.add(c.ok === false ? 'fail' : 'done')
        row.node.ms.textContent = `${fmt(Number(c.ms) || 0)} ms`
        row.node.l2.textContent = c.result ? String(c.result) : c.ok === false ? 'failed' : 'ok'
      } })
      t += dur + 450
    })
    // decoded fields, one scan box at a time
    plan.push({ at: t, run: () => { lightNode(-1); $('name').classList.remove('typing') } })
    const fields = fieldsOf(read)
    fields.forEach(([k, v], i) => {
      plan.push({ at: t + 150 + i * 380, run: () => {
        const d = el('div', 'fd'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', v)); fieldsEl.appendChild(d)
      } })
    })
    t += 150 + fields.length * 380 + 300
    // verdict
    plan.push({ at: t, run: () => {
      while (vd.childNodes.length > 1) vd.removeChild(vd.lastChild)
      const word = VERDICT[read.verdict] ?? String(read.verdict ?? '').toUpperCase()
      vd.appendChild(el('b', read.verdict === 'kept' ? 'kept' : 'rej', word))
      vd.appendChild(el('span', 'why', read.verdict === 'kept' ? `training data · ${read.reason ?? ''}` : read.reason ?? ''))
      vd.classList.remove('flash'); void vd.offsetWidth; vd.classList.add('flash')
    } })
    const hold = queue.length > 3 ? 1600 : queue.length > 0 ? 3200 : 5200
    cur = { read, plan, t: 0, i: 0, dur: t + hold }
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
        if (cur.t >= cur.dur && queue.length) start(queue.shift())
      } else if (queue.length) start(queue.shift())
      if (cur) $('ago').textContent = `read ${ago(cur.read.ts)}`
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ── data ──
  let pollTimer = 0
  let backoff = POLL_MS
  let etag = ''
  let lastStats = 0
  async function poll() {
    pollTimer = 0
    if (stopped || !visible()) return
    try {
      const r = await fetch('/api/chain/feed?scan=1&limit=12', { cache: 'no-cache', headers: etag ? { 'If-None-Match': etag } : {} })
      if (r.status === 304) backoff = POLL_MS
      else if (r.ok) {
        etag = r.headers.get('ETag') || ''
        const j = await r.json()
        const reads = Array.isArray(j) ? j : Array.isArray(j.items) ? j.items : []
        if (!lastTs && reads.length) {
          // first load: start a few reads back so the player is moving at once (all real, with their times)
          const recent = reads.slice().sort((a, b) => b.ts - a.ts).slice(0, 3)
          lastTs = Math.min(...recent.map((x) => x.ts)) - 1
        }
        enqueue(reads)
        backoff = POLL_MS
      } else backoff = Math.min(60000, backoff * 2)
    } catch { backoff = Math.min(60000, backoff * 2) }
    if (Date.now() - lastStats > STATS_MS) stats()
    schedule(backoff)
  }
  async function stats() {
    lastStats = Date.now()
    try {
      const r = await fetch('/api/chain/stats', { cache: 'no-cache' })
      if (!r.ok) return
      const s = await r.json()
      $('count').textContent = `${fmt(s.reads)} reads · ${fmt(s.kept)} kept`
    } catch { /* keep the last numbers */ }
  }
  function schedule(ms) {
    if (pollTimer || stopped) return
    pollTimer = setTimeout(poll, ms)
  }
  function kick() { if (!pollTimer && !stopped) schedule(0) }
  function pause() {
    stopped = true
    if (pollTimer) clearTimeout(pollTimer)
    st.classList.add('paused')
    $('live').textContent = 'PAUSED'
  }
  kick()
})()
