// LUSCA Lens player (X player card). Asks the existing /api/lens/:chain/:address once (its cache, in-flight
// dedupe, per-IP limits and daily budget slice apply unchanged), shows "reading…" until it answers, then plays
// the readout. Errors are shown as the server words them. Animates only while on screen; stops after 20 visible minutes.
;(() => {
  'use strict'
  const MAX_VISIBLE_MS = 20 * 60 * 1000
  const $ = (id) => document.getElementById(id)
  const st = $('st')
  const m = /^\/play\/lens\/(solana|ethereum|base|arbitrum)\/([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})\/?$/.exec(location.pathname)
  const CHAIN_ID = m ? m[1] : null
  const ADDR = m ? (m[1] === 'solana' ? m[2] : m[2].toLowerCase()) : null

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

  const fmt = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '—')
  const short = (a, n = 4) => (typeof a === 'string' && a.length > 2 * n + 3 ? `${a.slice(0, n + (a.startsWith('0x') ? 2 : 0))}…${a.slice(-n)}` : a ? String(a) : '—')
  const CHAIN = { solana: 'SOL', ethereum: 'ETH', base: 'BASE', arbitrum: 'ARB' }
  const base = (f) => String(f || '').split('/').pop()
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
  // value parts: [text, cls] where cls 'b' = accent, 'em' = dim
  const V = (...parts) => parts.filter((p) => p && p[0] !== undefined && p[0] !== null && p[0] !== '')

  function verifiedText(r) {
    const v = r.summary.verified
    if (v === 'osec') return V(['OtterSec', 'b'], [' verified build'])
    if (v === 'sourcify-full' || v === 'sourcify-partial') {
      const c = r.evm && (r.evm.implementation || r.evm.self)
      const comp = c && c.verified && c.verified.compiler ? String(c.verified.compiler).split('+')[0] : ''
      return V(['Sourcify ' + (v === 'sourcify-full' ? 'full' : 'partial'), 'b'], comp ? [` · ${comp}`, 'em'] : null)
    }
    if (v === 'unknown') return V(['registry not reachable at read time', 'em'])
    return V([r.chain === 'solana' ? 'no verified build' : 'no verified source'])
  }

  function rowsOf(r) {
    const s = r.summary
    const R = [['verified', verifiedText(r)]]
    if (r.chain === 'solana') {
      const so = r.solana || {}
      R.push(['upgradeable', s.upgradeable === false ? V(['no · immutable']) : s.upgradeable ? V(['yes'], s.authority ? [` · authority ${short(s.authority)}`, 'em'] : null) : V(['not read', 'em'])])
      if (so.loader) R.push(['loader', V([so.loader])])
      if (so.programBytes) R.push(['program size', V([`${fmt(so.programBytes)} bytes`])])
      R.push(['anchor idl', so.idl ? V([so.idl.name || 'idl', 'b'], [` · ${fmt((so.idl.instructions || []).length)} instructions`, 'em']) : V(['none published', 'em'])])
      R.push(['primitives', s.primitives ? V([String(s.primitives), 'b'], [` · ${(r.primitives || []).slice(0, 3).map((p) => p.name).join(', ')}`, 'em']) : V(['none imported', 'em'])])
    } else {
      const e = r.evm || {}
      const c = e.implementation || e.self || {}
      R.push(['proxy', e.proxy ? V([e.proxy.label]) .concat(V([` → ${short(e.proxy.implementation)}`, 'em'])) : V(['not a proxy', 'em'])])
      if (e.proxy) R.push(['proxy admin', e.proxy.admin ? V([short(e.proxy.admin)]) : V(['not in a standard slot', 'em'])])
      const fns = c.functions || { write: [], payable: [], view: [] }
      if (s.surface != null) R.push(['functions', V([fmt(s.surface), 'b'], [` · ${fmt(fns.write.length + fns.payable.length)} write · ${fmt(fns.view.length)} view`, 'em'])])
      R.push(['admin-only', s.privileged == null ? V(['not analysed', 'em']) : V([fmt(s.privileged), 'b'], [s.privileged === 1 ? ' function' : ' functions', 'em'])])
      if (c.bytecodeBytes) R.push(['bytecode', V([`${fmt(c.bytecodeBytes)} bytes`], e.implementation ? [' · implementation', 'em'] : null)])
    }
    if (R.length < 7) R.push(['code index', s.provenance ? V([`${fmt(s.provenance)} files`, 'b'], [` match · ${fmt(s.provenanceExact || 0)} byte-identical`, 'em']) : V(['no file matches', 'em'])])
    return R.slice(0, 7)
  }

  function panelOf(r) {
    if (r.chain !== 'solana') {
      const e = r.evm || {}
      const c = e.implementation || e.self || {}
      const pv = Array.isArray(c.privileged) ? c.privileged : []
      if (pv.length) return { k: 'admin-only functions', n: pv.length > 3 ? `+${pv.length - 3} more` : `${pv.length}`, items: pv.slice(0, 3).map((p) => [p.fn, p.guard, `${base(p.file)}:${p.line}`]) }
      if (c.analysis) return { k: 'source analysis', n: '', items: [[c.analysis, '', '']] }
      return null
    }
    const so = r.solana || {}
    const roles = Array.isArray(so.signerRoles) ? so.signerRoles : []
    if (roles.length) return { k: 'authority signers', n: roles.length > 3 ? `+${roles.length - 3} more` : `${roles.length}`, items: roles.slice(0, 3).map((x) => [x.instruction, x.account, 'idl']) }
    const ix = so.idl && Array.isArray(so.idl.instructions) ? so.idl.instructions : []
    if (ix.length) return { k: 'instructions', n: ix.length > 3 ? `+${ix.length - 3} more` : `${ix.length}`, items: ix.slice(0, 3).map((x) => [x.name, `${(x.accounts || []).length} accounts`, 'idl']) }
    const pr = Array.isArray(r.primitives) ? r.primitives : []
    if (pr.length) return { k: 'primitives', n: `${pr.length}`, items: pr.slice(0, 3).map((p) => [p.name, p.group, p.via]) }
    return null
  }

  // ── states ──
  function target() {
    const chip = $('chain'); chip.textContent = CHAIN[CHAIN_ID] || '—'; chip.className = 'chip' + (CHAIN_ID === 'solana' ? ' sol' : '')
    $('kind').textContent = CHAIN_ID === 'solana' ? 'program' : 'contract'
    $('name').textContent = short(ADDR, 6)
    $('addr').textContent = ADDR
    $('out').href = `https://lusca.ink/lens/${CHAIN_ID}/${ADDR}`
    $('out').textContent = `lusca.ink/lens · ${short(ADDR)} ↗`
    const rows = $('rows'); rows.textContent = ''
    for (const k of CHAIN_ID === 'solana' ? ['verified', 'upgradeable', 'loader', 'program size', 'anchor idl', 'primitives', 'code index'] : ['verified', 'proxy', 'proxy admin', 'functions', 'admin-only', 'bytecode', 'code index']) {
      const d = el('div', 'rr ph'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', '')); rows.appendChild(d)
    }
  }

  function fail(msg, retryIn) {
    st.classList.add('err')
    $('live').textContent = 'NO READ'
    $('name').classList.remove('typing')
    const rows = $('rows'); rows.textContent = ''
    const d = el('div', 'msg'); d.appendChild(el('b', '', 'lens answered')); d.appendChild(document.createTextNode(msg)); rows.appendChild(d)
    if (retryIn) d.appendChild(el('div', 'dim', `asking again in ${retryIn}s`))
    $('scan').className = 'ro-scan'
    $('vtext').textContent = 'no read'
  }

  let report = null
  let cur = null
  function play(ans) {
    const r = ans.report
    const plan = []
    const rows = rowsOf(r)
    const panel = panelOf(r)
    plan.push({ at: 0, run: () => {
      st.classList.remove('err'); st.classList.add('done')
      $('live').textContent = ans.cached ? 'READ · CACHED' : 'READ'
      const nm = $('name'); nm.textContent = r.name || short(r.address, 6); nm.className = 'nm typing' + (r.name ? '' : ' addr')
      $('kind').textContent = `${r.kind}${r.evm && r.evm.proxy ? ' · proxy' : ''}`
      $('ago').textContent = `read ${ago(r.readAt)}`
      $('meta').textContent = `${fmt(r.ms)} ms · ${fmt(r.rpcCalls)} rpc · ${fmt(r.registryCalls)} registry`
      const box = $('rows'); box.textContent = ''
      for (const [k] of rows) { const d = el('div', 'rr'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v')); box.appendChild(d) }
      $('pv').textContent = ''
      const vd = $('vd'); while (vd.childNodes.length > 1) vd.removeChild(vd.lastChild); vd.appendChild(el('span', 'dim', 'judging…'))
      const sc = $('scan'); sc.className = 'ro-scan'; void sc.offsetWidth; sc.className = 'ro-scan once'
    } })
    rows.forEach(([, parts], i) => plan.push({ at: 200 + i * 170, run: () => {
      const v = $('rows').children[i] && $('rows').children[i].querySelector('.v')
      if (!v) return
      v.textContent = ''
      for (const [t, c] of parts) v.appendChild(c ? el(c, '', t) : document.createTextNode(t))
      v.classList.add('in')
    } }))
    let t = 200 + rows.length * 170 + 300
    plan.push({ at: t, run: () => $('name').classList.remove('typing') })
    if (panel) {
      plan.push({ at: t, run: () => { const pv = $('pv'); const l = el('div', 'lab'); l.appendChild(el('span', '', panel.k)); l.appendChild(el('span', '', panel.n)); pv.appendChild(l) } })
      panel.items.forEach(([fn, g, at], i) => plan.push({ at: t + 150 + i * 260, run: () => {
        const d = el('div', 'pf'); d.style.animationDelay = '0ms'
        const f = el('span', 'fn', fn); if (g) f.appendChild(el('em', '', g)); d.appendChild(f); d.appendChild(el('span', 'at', at)); $('pv').appendChild(d)
      } }))
      t += 150 + panel.items.length * 260 + 250
    }
    plan.push({ at: t, run: () => {
      const vd = $('vd'); while (vd.childNodes.length > 1) vd.removeChild(vd.lastChild)
      const ds = r.dataset || {}
      vd.appendChild(el('b', ds.verdict === 'kept' ? 'kept' : 'rej', ds.verdict === 'kept' ? 'KEPT' : 'REJECTED'))
      vd.appendChild(el('span', 'why', ds.verdict === 'kept' ? `training data · ${ds.reason || ''}` : ds.reason || String(ds.verdict || '')))
      vd.classList.remove('flash'); void vd.offsetWidth; vd.classList.add('flash')
    } })
    cur = { ans, plan, t: 0, i: 0, dur: t + 9000 }
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
        if (cur.t >= cur.dur) play(cur.ans)
        $('ago').textContent = `read ${ago(cur.ans.report.readAt)}`
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ── data: one request; on busy / budget / timeout answers, at most three more, spaced out ──
  let timer = 0
  let busy = false
  let tries = 0
  async function load() {
    timer = 0
    if (stopped || report || busy || !visible()) return
    busy = true
    tries++
    try {
      const r = await fetch(`/api/lens/${CHAIN_ID}/${ADDR}`, { cache: 'default' })
      const j = await r.json().catch(() => null)
      if (r.ok && j && j.report) { report = j; play(j) }
      else {
        const ra = Number(r.headers.get('Retry-After')) || 0
        const again = (r.status === 429 || r.status === 503 || r.status === 504) && tries < 4 ? Math.max(20, ra) : 0
        fail((j && j.error) || `HTTP ${r.status}`, again)
        if (again) timer = setTimeout(load, again * 1000)
        else tries = 4
      }
    } catch {
      const again = tries < 4 ? 20 : 0
      fail('the server could not be reached', again)
      if (again) timer = setTimeout(load, again * 1000)
    } finally { busy = false }
  }
  function kick() { if (!timer && !report && !stopped && CHAIN_ID && tries < 4) load() }
  function pause() {
    stopped = true
    if (timer) clearTimeout(timer)
    st.classList.add('paused')
    $('live').textContent = 'PAUSED'
  }

  if (!CHAIN_ID) { fail('this link names no contract or program'); return }
  target()
  kick()
})()
