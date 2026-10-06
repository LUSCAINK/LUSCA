// Proof of contribution — the epoch hash chain, in-browser verification of your own credits and
// of the whole chain, and the payout preview. Every hash on this panel is recomputed here with
// WebCrypto from data the server publishes (shared/proofs.ts holds the exact byte format); the
// server's word is only taken for what it is asked to prove.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  canonicalHeader,
  headerHashAsync,
  leafBytes,
  leafHashAsync,
  merkleRootAsync,
  subtleSha256,
  utf8,
  bytesToHex,
  verifyHeadersAsync,
  walkPath,
  type EpochHeader,
  type PathStep,
  type PayoutPreviewData,
  type ProofChainPage,
  type ProofIdentity,
  type ProofLeaf,
  type ProofLeaves,
  type ProofLookup,
} from '@shared/proofs'
import { LAMPORTS_PER_SOL, estimateFees, planPayout, type RulesLamports } from '@shared/payoutPlan'
import { useNow } from '@/lib/hooks'
import { useWallet, authToken } from '@/lib/wallet'
import { storedDeviceId } from '@/lib/account'
import { fmtInt } from '@/lib/format'
import { Head } from '@/components/treasury/bits'
import { DASH, fmtCountdown, fmtInk, fmtUtc } from '@/components/treasury/format'
import './proofs.css'

const sha = typeof crypto !== 'undefined' && crypto.subtle ? subtleSha256(crypto.subtle) : null
const short = (h: string | null | undefined, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : DASH)
const credits = (micro: number | null | undefined) => (micro == null ? DASH : fmtInk(micro / 1e6))
const fmtFlops = (f: number) => (f >= 1e15 ? `${(f / 1e15).toFixed(2)} PFLOP` : f >= 1e12 ? `${(f / 1e12).toFixed(2)} TFLOP` : `${(f / 1e9).toFixed(1)} GFLOP`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const body = (await res.json().catch(() => null)) as T & { error?: string }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

async function postJson<T>(url: string, data: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(data) })
  const body = (await res.json().catch(() => null)) as T & { error?: string }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body
}

/** The caller's identity material, as account.watch sends it. */
function useIdentity() {
  const status = useWallet((s) => s.status)
  const [device, setDevice] = useState<string | null>(() => storedDeviceId())
  useEffect(() => {
    const t = setInterval(() => setDevice(storedDeviceId()), 3000)
    return () => clearInterval(t)
  }, [])
  const auth = status === 'verified' ? authToken() : null
  return { auth, device, any: !!auth || !!device }
}

/* ─── chain ──────────────────────────────────────────────── */

type BlockMark = 'idle' | 'checking' | 'ok' | 'bad'

function Block({ h, mark, selected, onPick }: { h: EpochHeader; mark: BlockMark; selected: boolean; onPick: () => void }) {
  return (
    <li className={`poc-blk poc-${mark}${selected ? ' poc-sel' : ''}${h.index === 0 ? ' poc-gen' : ''}`}>
      <button type="button" className="poc-blk-b" onClick={onPick} aria-pressed={selected} aria-label={`Epoch ${h.index}`}>
        <span className="poc-blk-top">
          <span className="poc-idx num">#{h.index}</span>
          <span className="poc-tag">{h.index === 0 ? 'genesis' : mark === 'ok' ? 'verified' : mark === 'bad' ? 'mismatch' : mark === 'checking' ? 'hashing' : 'closed'}</span>
        </span>
        <span className="poc-kv">
          <span>root</span>
          <span className="num">{short(h.treeRoot, 8)}</span>
        </span>
        <span className="poc-kv">
          <span>leaves</span>
          <span className="num">{fmtInt(h.leafCount)}</span>
        </span>
        <span className="poc-kv">
          <span>credits</span>
          <span className="num">{credits(h.totals.credits)}</span>
        </span>
        <span className="poc-hash num" title={h.headerHash}>
          {short(h.headerHash, 12)}
        </span>
      </button>
      <span className="poc-link" aria-hidden="true">
        <span className="poc-link-l" />
        <span className="poc-link-t num">{h.prevHeaderHash.slice(0, 6)}</span>
      </span>
    </li>
  )
}

function OpenBlock({ open, now }: { open: NonNullable<ProofChainPage['open']>; now: number }) {
  return (
    <li className="poc-blk poc-open">
      <div className="poc-blk-b">
        <span className="poc-blk-top">
          <span className="poc-idx num">#{open.index}</span>
          <span className="poc-tag">open</span>
        </span>
        <span className="poc-kv">
          <span>collecting since</span>
          <span className="num">{fmtUtc(open.startedAt).slice(11)}</span>
        </span>
        <span className="poc-kv">
          <span>closes in</span>
          <span className="num hot">{fmtCountdown(open.closesAt - now)}</span>
        </span>
        <span className="poc-hash num">root set at close</span>
      </div>
      <span className="poc-link" aria-hidden="true">
        <span className="poc-link-l" />
      </span>
    </li>
  )
}

interface ChainRun {
  state: 'idle' | 'running' | 'ok' | 'bad' | 'error'
  checked: number
  total: number
  roots: number
  msg: string
  ms: number
}

/** Every header from the API, oldest first (paged, newest first on the wire). */
async function fetchAllHeaders(max = 5000): Promise<EpochHeader[]> {
  const out: EpochHeader[] = []
  let before: number | null = null
  for (;;) {
    const page: ProofChainPage = await getJson<ProofChainPage>(`/api/proofs?limit=100${before !== null ? `&before=${before}` : ''}`)
    out.push(...page.headers)
    if (page.next === null || out.length >= max) break
    before = page.next
  }
  return out.sort((a, b) => a.index - b.index)
}

function Detail({ h, onClose }: { h: EpochHeader; onClose: () => void }) {
  const [root, setRoot] = useState<{ state: 'idle' | 'busy' | 'ok' | 'bad'; value?: string; n?: number }>({ state: 'idle' })
  const [hh, setHh] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    if (sha) void headerHashAsync(sha, h).then((v) => live && setHh(v))
    return () => {
      live = false
    }
  }, [h])
  const recompute = async () => {
    if (!sha) return
    setRoot({ state: 'busy' })
    try {
      const data = await getJson<ProofLeaves>(`/api/proofs/${h.index}/leaves.json`)
      const r = await merkleRootAsync(sha, h.index, data.leaves)
      setRoot({ state: r === h.treeRoot ? 'ok' : 'bad', value: r, n: data.leaves.length })
    } catch {
      setRoot({ state: 'bad' })
    }
  }
  return (
    <div className="panel poc-detail">
      <Head k="H" title={`Epoch ${h.index} header`} meta={<button type="button" className="poc-x" onClick={onClose} aria-label="Close header detail">close ×</button>} />
      <div className="poc-detail-b">
        <div className="poc-dl">
          <span className="label">window</span>
          <span className="num">
            {fmtUtc(h.startedAt)} → {fmtUtc(h.endedAt).slice(11)}
          </span>
          <span className="label">totals</span>
          <span className="num">
            {credits(h.totals.credits)} credits · {fmtInt(h.totals.jobs)} jobs · {fmtFlops(h.totals.flops)}
          </span>
          <span className="label">ledger lifetime at close</span>
          <span className="num">{credits(h.totals.ledgerCredits)} credits</span>
        </div>
        <span className="label">canonical header (what headerHash is computed over)</span>
        <pre className="poc-pre mono">{canonicalHeader(h)}</pre>
        <div className="poc-dl">
          <span className="label">headerHash (server)</span>
          <span className="num poc-wrap">{h.headerHash}</span>
          <span className="label">sha256 in this browser</span>
          <span className={`num poc-wrap ${hh ? (hh === h.headerHash ? 'poc-good' : 'poc-badt') : ''}`}>{hh ?? 'hashing…'}</span>
          <span className="label">treeRoot</span>
          <span className="num poc-wrap">{h.treeRoot}</span>
          {root.value && (
            <>
              <span className="label">root from leaves.json</span>
              <span className={`num poc-wrap ${root.state === 'ok' ? 'poc-good' : 'poc-badt'}`}>{root.value}</span>
            </>
          )}
        </div>
        <div className="poc-row">
          <button type="button" className="btn" onClick={() => void recompute()} disabled={!sha || root.state === 'busy'}>
            {root.state === 'busy' ? 'Hashing leaves…' : 'Recompute root from public leaves'}
          </button>
          <a className="btn ghost" href={`/api/proofs/${h.index}/leaves.json`} target="_blank" rel="noreferrer">
            leaves.json ↗
          </a>
          {root.state === 'ok' && <span className="poc-res poc-good">{fmtInt(root.n ?? 0)} leaves hash to treeRoot</span>}
          {root.state === 'bad' && <span className="poc-res poc-badt">root mismatch or leaves unavailable</span>}
        </div>
      </div>
    </div>
  )
}

/* ─── verify my credits ──────────────────────────────────── */

interface StepView {
  sibling: string | null
  side: 'L' | 'R' | null
  out: string
}

interface MyCheck {
  scope: 'wallet' | 'device'
  epoch: number
  leaf: ProofLeaf
  idLocal: string | null
  leafLocal: string
  leafServer: string
  steps: StepView[]
  shown: number
  root: string
  headerOk: boolean
  inChain: boolean | null
  pass: boolean
  header: EpochHeader
}

function MyProof({ chain }: { chain: Map<number, EpochHeader> }) {
  const { auth, device, any } = useIdentity()
  const wallet = useWallet((s) => (s.status === 'verified' ? s.session?.wallet ?? null : null))
  const [ids, setIds] = useState<ProofIdentity[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checks, setChecks] = useState<MyCheck[]>([])
  const [none, setNone] = useState<string | null>(null)
  const runId = useRef(0)

  const verifyEpoch = useCallback(
    async (epoch: number) => {
      if (!sha) return
      const id = ++runId.current
      setBusy(true)
      setErr(null)
      setNone(null)
      setChecks([])
      try {
        const res = await postJson<{ proofs: ProofLookup[] }>(`/api/proofs/${epoch}/proof`, { auth, device })
        const out: MyCheck[] = []
        for (const p of res.proofs) {
          if (!p.leaf || !p.leafHash) continue
          const leafLocal = await leafHashAsync(sha, p.header.index, p.leaf)
          const idLocal = p.scope === 'wallet' && wallet ? bytesToHex(await sha(utf8(`lusca:id:v1:wallet:${wallet}`))) : null
          const trace = await walkPath(sha, leafLocal, p.path as PathStep[])
          const hh = await headerHashAsync(sha, p.header)
          const known = chain.get(p.header.index)
          const inChain = known ? known.headerHash === p.header.headerHash : null
          const headerOk = hh === p.header.headerHash
          const pass = leafLocal === p.leafHash && trace.root === p.header.treeRoot && headerOk && inChain !== false && (idLocal === null || idLocal === p.leaf.id)
          out.push({ scope: p.scope, epoch: p.header.index, leaf: p.leaf, idLocal, leafLocal, leafServer: p.leafHash, steps: trace.steps, shown: 0, root: trace.root, headerOk, inChain, pass, header: p.header })
        }
        if (id !== runId.current) return
        if (!out.length) {
          setNone(`No confirmed credits for this browser's identities in epoch ${epoch}.`)
          return
        }
        setChecks(out)
        // reveal each hash step in turn
        const total = Math.max(...out.map((c) => c.steps.length))
        for (let s = 1; s <= total; s++) {
          if (!reduced()) await sleep(s === 1 ? 260 : 180)
          if (id !== runId.current) return
          setChecks((cs) => cs.map((c) => ({ ...c, shown: Math.min(c.steps.length, s) })))
        }
      } catch (e) {
        if (id === runId.current) setErr((e as Error).message)
      } finally {
        if (id === runId.current) setBusy(false)
      }
    },
    [auth, device, wallet, chain],
  )

  const lookup = async () => {
    setErr(null)
    setBusy(true)
    try {
      const res = await postJson<{ identities: ProofIdentity[] }>('/api/proofs/mine', { auth, device })
      setIds(res.identities)
      const newest = Math.max(-1, ...res.identities.map((i) => i.epochs[0] ?? -1))
      setBusy(false)
      if (newest >= 0) await verifyEpoch(newest)
      else setNone('No epoch holds confirmed credits for this browser yet. Credits enter the next epoch once they are confirmed.')
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  const epochs = useMemo(() => {
    const s = new Set<number>()
    for (const i of ids ?? []) for (const e of i.epochs) s.add(e)
    return [...s].sort((a, b) => b - a).slice(0, 24)
  }, [ids])

  return (
    <div className="panel poc-mine">
      <Head k="V" title="Verify my credits" meta={wallet ? 'wallet + this device' : device ? 'this device' : 'no identity'} />
      <div className="poc-mine-b">
        <p className="poc-p">
          The server returns your leaf and its Merkle path. This browser re-encodes the leaf, hashes it with WebCrypto, walks the path to the root and checks the
          root against the epoch header it re-hashed itself.
        </p>
        <div className="poc-row">
          <button type="button" className="btn primary" onClick={() => void lookup()} disabled={!any || busy || !sha}>
            {busy ? 'Verifying…' : 'Verify my credits'}
          </button>
          {!any && <span className="poc-res">Run a neuron on this browser or verify a wallet first.</span>}
          {!sha && <span className="poc-res poc-badt">WebCrypto is not available on this page (needs https).</span>}
        </div>
        {epochs.length > 0 && (
          <div className="poc-chips" role="group" aria-label="Epochs holding your credits">
            {epochs.map((e) => (
              <button key={e} type="button" className={`poc-chip num${checks[0]?.epoch === e ? ' on' : ''}`} onClick={() => void verifyEpoch(e)} disabled={busy}>
                #{e}
              </button>
            ))}
          </div>
        )}
        {err && <p className="poc-res poc-badt">{err}</p>}
        {none && <p className="poc-res">{none}</p>}
        {checks.map((c) => (
          <div key={`${c.scope}-${c.epoch}`} className={`poc-check${c.shown >= c.steps.length ? (c.pass ? ' pass' : ' fail') : ''}`}>
            <div className="poc-check-h">
              <span className="label">
                epoch #{c.epoch} · {c.scope === 'wallet' ? 'verified wallet' : 'this device'}
              </span>
              <span className="poc-amt num">{credits(c.leaf.credits)} credits</span>
            </div>
            <div className="poc-dl">
              <span className="label">leaf</span>
              <span className="num">
                epoch {c.epoch} · id {short(c.leaf.id, 12)} · {c.leaf.credits} µcredits · {fmtInt(c.leaf.jobs)} jobs · {fmtFlops(c.leaf.flops)}
              </span>
              <span className="label">leaf bytes (61, encoded here)</span>
              <span className="num poc-wrap poc-bytes">{bytesToHex(leafBytes(c.epoch, c.leaf)).replace(/^(..)(.{8})(.{64})(.{16})(.{16})(.{16})$/, '$1 $2 $3 $4 $5 $6')}</span>
              {c.idLocal && (
                <>
                  <span className="label">identity from your address</span>
                  <span className={`num poc-wrap ${c.idLocal === c.leaf.id ? 'poc-good' : 'poc-badt'}`}>{c.idLocal}</span>
                </>
              )}
            </div>
            <ol className="poc-steps">
              {c.steps.slice(0, Math.max(1, c.shown)).map((s, i) => (
                <li key={i} className="poc-step">
                  <span className="poc-step-n num">{i === 0 ? 'leaf' : `h${i}`}</span>
                  <span className="poc-step-f mono">{i === 0 ? 'sha256(0x00 ‖ leaf bytes)' : s.side === 'L' ? `sha256(0x01 ‖ ${short(s.sibling, 6)} ‖ h${i - 1})` : `sha256(0x01 ‖ h${i - 1} ‖ ${short(s.sibling, 6)})`}</span>
                  <span className="poc-step-o num">{s.out}</span>
                </li>
              ))}
            </ol>
            {c.steps.length === 1 && <p className="poc-res">Only leaf in this epoch: its hash is the tree root, so the path is empty.</p>}
            {c.shown >= c.steps.length && (
              <div className="poc-verdict">
                <span className="poc-v-big">{c.pass ? 'PASS' : 'FAIL'}</span>
                <ul className="poc-v-l mono">
                  <li className={c.leafLocal === c.leafServer ? 'ok' : 'no'}>leaf hash recomputed here matches</li>
                  <li className={c.root === c.header.treeRoot ? 'ok' : 'no'}>path ends at treeRoot {short(c.header.treeRoot, 8)}</li>
                  <li className={c.headerOk ? 'ok' : 'no'}>header re-hashed here = {short(c.header.headerHash, 8)}</li>
                  <li className={c.inChain === null ? '' : c.inChain ? 'ok' : 'no'}>
                    {c.inChain === null ? 'header not in the loaded chain view' : 'same header as in the public chain'}
                  </li>
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── payout preview ─────────────────────────────────────── */

function PayoutPreview() {
  const { auth, device, any } = useIdentity()
  const [data, setData] = useState<PayoutPreviewData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pool, setPool] = useState('')
  useEffect(() => {
    if (!any) return
    let live = true
    postJson<PayoutPreviewData>('/api/proofs/preview', { auth, device })
      .then((d) => live && (setData(d), setErr(null)))
      .catch((e: Error) => live && setErr(e.message))
    return () => {
      live = false
    }
  }, [auth, device, any])

  const poolSol = Number(pool)
  const valid = pool.trim() !== '' && Number.isFinite(poolSol) && poolSol > 0 && poolSol <= 1e7
  const result = useMemo(() => {
    if (!data || !valid) return null
    const viaWallet = data.you.walletCredits > 0
    const own = viaWallet ? data.you.walletCredits : data.you.deviceCredits
    if (!(own > 0)) return { own, viaWallet, row: null, share: 0 }
    // Device credits are not in the snapshot until linked to a verified wallet: add them as if linked now.
    const others = Math.max(0, data.totalCredits - (viaWallet ? own : 0))
    const wallets = data.wallets + (viaWallet ? 0 : 1)
    const poolLamports = Math.round(poolSol * LAMPORTS_PER_SOL)
    const snapshot = [{ wallet: 'you', ink: own }, ...(others > 0 ? [{ wallet: 'others', ink: others }] : [])]
    const rules: RulesLamports = { share: 1, reserveLamports: 0, maxLamports: poolLamports, maxWalletLamports: data.rules.maxWalletLamports, minLamports: data.rules.minLamports }
    // planPayout derives the pool from a balance: hand it exactly pool + its own fee estimate.
    const plan = planPayout(poolLamports + estimateFees(snapshot.length), snapshot, rules)
    return { own, viaWallet, row: plan.rows[0], share: own / (own + others), wallets }
  }, [data, valid, poolSol])

  return (
    <div className="panel poc-prev">
      <Head k="P" title="Payout preview" meta={data ? (data.mode === 'live' ? 'payouts live' : 'preview · payouts are off') : DASH} />
      <div className="poc-prev-b">
        <p className="poc-p">
          Runs the payout engine's own <span className="mono">planPayout()</span> on your credits since the last closed period, against every verified wallet's.
          {data?.mode !== 'live' && ' Payouts are off: this is a preview, nothing is sent.'}
        </p>
        {!any && <p className="poc-res">Run a neuron on this browser or verify a wallet to see your share.</p>}
        {err && <p className="poc-res poc-badt">{err}</p>}
        {data && (
          <div className="poc-dl">
            <span className="label">your period credits</span>
            <span className="num">
              {fmtInk(data.you.walletCredits > 0 ? data.you.walletCredits : data.you.deviceCredits)}
              {data.you.walletCredits > 0 ? ' · verified wallet' : data.you.deviceCredits > 0 ? ' · this device (not linked to a wallet)' : ''}
            </span>
            <span className="label">all verified wallets</span>
            <span className="num">
              {fmtInk(data.totalCredits)} credits · {fmtInt(data.wallets)} wallets
            </span>
            <span className="label">period since</span>
            <span className="num">{data.periodSince ? fmtUtc(data.periodSince) : 'no period closed yet (all credits so far)'}</span>
          </div>
        )}
        <label className="poc-pool">
          <span className="label">pool to split (SOL)</span>
          <input className="mono" inputMode="decimal" value={pool} onChange={(e) => setPool(e.target.value)} placeholder="enter a pool" aria-label="Pool to split, in SOL" />
        </label>
        {result && result.row && (
          <div className="poc-out">
            <div>
              <span className="label">your share</span>
              <span className="poc-big num">{(result.share * 100).toLocaleString('en-US', { maximumFractionDigits: 3 })}%</span>
            </div>
            <div>
              <span className="label">{result.row.reason === 'dust' ? 'below the minimum' : result.row.reason === 'cap' ? 'capped at the per-wallet max' : 'you would receive'}</span>
              <span className="poc-big num hot">{(result.row.lamports / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL</span>
            </div>
            <p className="poc-res">
              {result.row.carryInk > 0 ? `${fmtInk(result.row.carryInk)} credits would carry over to the next period. ` : ''}
              {!result.viaWallet ? 'Device credits are paid only after this device is linked to a verified wallet.' : ''}
            </p>
          </div>
        )}
        {result && !result.row && <p className="poc-res">No period credits on this identity yet.</p>}
      </div>
    </div>
  )
}

/* ─── section ────────────────────────────────────────────── */

export function ProofOfContribution() {
  const now = useNow(1000)
  const [page, setPage] = useState<ProofChainPage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [marks, setMarks] = useState<Map<number, BlockMark>>(new Map())
  const [run, setRun] = useState<ChainRun>({ state: 'idle', checked: 0, total: 0, roots: 0, msg: '', ms: 0 })
  const [all, setAll] = useState<Map<number, EpochHeader>>(new Map())

  useEffect(() => {
    let live = true
    const load = () =>
      getJson<ProofChainPage>('/api/proofs?limit=12')
        .then((p) => {
          if (!live) return
          setPage(p)
          setErr(null)
          setAll((m) => {
            const n = new Map(m)
            for (const h of p.headers) n.set(h.index, h)
            return n
          })
        })
        .catch((e: Error) => live && setErr(e.message))
    void load()
    const t = setInterval(load, 30_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])

  // the open epoch closed: fetch the new head right away
  useEffect(() => {
    if (page?.open && now > page.open.closesAt + 20_000) {
      void getJson<ProofChainPage>('/api/proofs?limit=12').then(setPage).catch(() => undefined)
    }
  }, [now, page])

  const verifyChain = async () => {
    if (!sha) return
    const t0 = performance.now()
    setRun({ state: 'running', checked: 0, total: 0, roots: 0, msg: 'fetching headers…', ms: 0 })
    try {
      const headers = await fetchAllHeaders()
      setAll(new Map(headers.map((h) => [h.index, h])))
      setMarks(new Map(page?.headers.map((h) => [h.index, 'checking' as BlockMark]) ?? []))
      const res = await verifyHeadersAsync(sha, headers)
      // visual pass over the visible blocks, newest first, then recompute their roots from the public leaves
      let roots = 0
      let rootBad: number | null = null
      for (const h of page?.headers ?? []) {
        let ok = !res.bad || h.index < res.bad.index
        if (ok) {
          try {
            const leaves = await getJson<ProofLeaves>(`/api/proofs/${h.index}/leaves.json`)
            ok = (await merkleRootAsync(sha, h.index, leaves.leaves)) === h.treeRoot
            if (ok) roots++
            else rootBad ??= h.index
          } catch {
            /* leaves unavailable: header check stands */
          }
        }
        setMarks((m) => new Map(m).set(h.index, ok ? 'ok' : 'bad'))
        if (!reduced()) await sleep(90)
      }
      const ms = Math.round(performance.now() - t0)
      if (res.ok && rootBad === null) setRun({ state: 'ok', checked: res.checked, total: headers.length, roots, msg: '', ms })
      else setRun({ state: 'bad', checked: res.checked, total: headers.length, roots, msg: res.bad ? `epoch ${res.bad.index}: ${res.bad.reason}` : `epoch ${rootBad}: leaves do not hash to treeRoot`, ms })
    } catch (e) {
      setRun({ state: 'error', checked: 0, total: 0, roots: 0, msg: (e as Error).message, ms: 0 })
    }
  }

  const headers = page?.headers ?? []
  const selected = sel !== null ? (all.get(sel) ?? null) : null
  const st = page?.status

  return (
    <div id="ep-proofs" className="poc pk-anchor">
      <div className="poc-sh">
        <span className="label hot">Proof of contribution</span>
        <h3 className="display-cond poc-h">Every credit, committed to a public hash chain</h3>
        <p className="poc-p">
          Each {page ? `${page.epochMinutes}-minute` : ''} epoch closes with one Merkle leaf per identity that received confirmed credits, and a header that
          links to the previous one. Escrowed credits enter only once an audit confirms them; forfeited ones never do. Epoch 0 commits every balance that
          existed when proofs started.
        </p>
      </div>

      <div className={`poc-strip${st && !st.ok ? ' poc-strip-bad' : ''}`}>
        <span className={`led ${st ? (st.ok ? 'on' : 'tre-led-err') : 'pulse'}`} aria-hidden="true" />
        <p className="poc-strip-t" role="status">
          {err ? (
            <>proofs unavailable: {err}</>
          ) : !page ? (
            'loading the chain…'
          ) : (
            <>
              <b>{st?.ok ? 'chain verified on the server at start' : 'chain check failed on the server'}</b> · {fmtInt(st?.verified ?? 0)} epochs · head #
              {page.head?.index ?? DASH} {page.head ? short(page.head.headerHash, 10) : ''}
              {st?.error ? ` · ${st.error}` : ''}
            </>
          )}
        </p>
        <button type="button" className="btn poc-vbtn" onClick={() => void verifyChain()} disabled={!page || run.state === 'running' || !sha}>
          {run.state === 'running' ? 'Re-hashing…' : 'Verify the whole chain'}
        </button>
      </div>
      {run.state !== 'idle' && run.state !== 'running' && (
        <p className={`poc-runres mono ${run.state === 'ok' ? 'poc-good' : 'poc-badt'}`} role="status">
          {run.state === 'ok'
            ? `✓ ${fmtInt(run.checked)} headers re-hashed in this browser, every link holds · ${run.roots} newest roots recomputed from leaves.json · ${run.ms} ms`
            : run.state === 'bad'
              ? `✗ ${run.msg}`
              : `could not verify: ${run.msg}`}
        </p>
      )}

      <ol className="poc-chain" aria-label="Epoch chain, newest first">
        {page?.open && <OpenBlock open={page.open} now={now} />}
        {headers.map((h) => (
          <Block key={h.index} h={h} mark={marks.get(h.index) ?? 'idle'} selected={sel === h.index} onPick={() => setSel(sel === h.index ? null : h.index)} />
        ))}
        {page && page.next !== null && (
          <li className="poc-more mono">
            … {fmtInt(page.next)} older epoch{page.next === 1 ? '' : 's'} down to genesis
          </li>
        )}
      </ol>

      {selected && <Detail key={selected.index} h={selected} onClose={() => setSel(null)} />}

      <div className="poc-grid">
        <MyProof chain={all} />
        <PayoutPreview />
      </div>
    </div>
  )
}
