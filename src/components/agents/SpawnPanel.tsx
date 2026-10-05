// SPAWN AN AGENT — POST /api/spawn. The server answers with the AgentInfo and
// also broadcasts it over the websocket, so it appears in the roster and on the
// creature without any extra work here.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { AgentInfo } from '@shared/protocol'
import { SECTORS, agentCode } from '@shared/sectors'
import { StatePill } from '@/components/obs/parts'
import { useNow, useSampled } from '@/lib/hooks'
import { CONN_TEXT } from '@/lib/store'
import { DASH, fmtInt } from '@/lib/format'
import { shortAddr, useWallet } from '@/lib/wallet'
import { ArmPicker } from './ArmPicker'
import { MAX_AGENTS, NAME_RE, nextSlot } from './util'

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; msg: string; until?: number }
  | { kind: 'ok'; agent: AgentInfo }

const COOLDOWN_MS = 10_000

function nameProblem(name: string): string | null {
  if (!name) return null
  if (name.length < 2) return 'too short — at least 2 characters'
  if (name.length > 16) return 'too long — 16 characters max'
  if (!NAME_RE.test(name)) return 'only a–z, 0–9 and - are allowed'
  return null
}

export function SpawnPanel({ sector, onSector, onSpawned }: { sector: number; onSector: (s: number) => void; onSpawned: (a: AgentInfo) => void }) {
  const ids = useId()
  const conn = useSampled((s) => s.conn, 300)
  const agents = useSampled((s) => s.agents, 400)
  const sectors = useSampled((s) => s.sectors, 1000)
  const address = useWallet((w) => w.address)
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [coolUntil, setCoolUntil] = useState(0)
  const now = useNow(500)
  const ctl = useRef<AbortController | null>(null)

  useEffect(() => () => ctl.current?.abort(), [])

  const live = conn === 'live'
  const problem = nameProblem(name)
  const valid = NAME_RE.test(name)
  const taken = valid && agents.some((a) => a.name === name)
  const cooling = Math.max(0, Math.ceil((Math.max(coolUntil, status.kind === 'error' ? (status.until ?? 0) : 0) - now) / 1000))
  const full = agents.length >= MAX_AGENTS
  const canSubmit = live && valid && !full && cooling === 0 && status.kind !== 'sending'
  const sec = SECTORS[sector]
  const info = sectors.find((s) => s.id === sector)
  const onArm = agents.filter((a) => a.sector === sector).length
  const code = live ? agentCode(sector, nextSlot(agents, sector)) : DASH
  const owner = address ?? 'anon'

  const spawned = status.kind === 'ok' ? (agents.find((a) => a.id === status.agent.id) ?? status.agent) : null
  const byHand = agents.filter((a) => a.origin === 'spawned').sort((a, b) => b.id - a.id)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!canSubmit) return
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    const timer = window.setTimeout(() => c.abort(), 8000)
    setStatus({ kind: 'sending' })
    try {
      const res = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, owner, sector }),
        signal: c.signal,
      })
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (!res.ok) {
        const srv = body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string' ? (body as { error: string }).error : null
        if (res.status === 429) {
          const ra = Number(res.headers.get('Retry-After')) || 10
          setStatus({ kind: 'error', msg: srv ?? `one spawn per 10 s — retry in ${ra} s`, until: Date.now() + ra * 1000 })
        } else if (res.status === 400) {
          setStatus({ kind: 'error', msg: srv ?? 'the server rejected that name or arm' })
        } else if (res.status === 503) {
          setStatus({ kind: 'error', msg: srv ?? 'server is starting — try again in a moment' })
        } else if (res.status >= 500 && !srv) {
          setStatus({ kind: 'error', msg: `the server could not add the agent (HTTP ${res.status}) — retry shortly` })
        } else {
          setStatus({ kind: 'error', msg: srv ? `${srv} (HTTP ${res.status})` : `spawn failed (HTTP ${res.status})` })
        }
        return
      }
      const agent = body as AgentInfo
      if (!agent || typeof agent.id !== 'number' || typeof agent.code !== 'string') {
        setStatus({ kind: 'error', msg: 'the server answered, but not with an agent' })
        return
      }
      setStatus({ kind: 'ok', agent })
      setCoolUntil(Date.now() + COOLDOWN_MS)
      setName('')
      setTouched(false)
      onSpawned(agent)
    } catch {
      if (c.signal.aborted && ctl.current !== c) return // superseded / unmounted
      setStatus({ kind: 'error', msg: c.signal.aborted ? 'no answer in 8 s — the server may be busy, retry shortly' : "couldn't reach the server — check the link and retry" })
    } finally {
      window.clearTimeout(timer)
    }
  }

  const hintId = `${ids}-hint`
  const statusId = `${ids}-status`
  const showProblem = (touched || name.length > 0) && problem

  return (
    <div className="spn">
      <p className="spn-lede">
        Spawning adds a real agent to the arm you pick: it starts fetching real pages on that topic within seconds and feeds the same corpus. It is{' '}
        <b>free and earns no INK</b> — INK is only for verified GPU work.
      </p>

      {!live && (
        <div className="spn-gate hatch" role="note">
          <span className="label">read-only</span>
          <p>{CONN_TEXT[conn]} Spawning unlocks when the server answers.</p>
        </div>
      )}

      <form className="spn-form" onSubmit={submit} noValidate aria-describedby={statusId}>
        <fieldset className="spn-field">
          <legend className="label">
            <span className="hot">01</span> · pick an arm
          </legend>
          <ArmPicker value={sector} onChange={onSector} agents={agents} label="Arm for the new agent" live={live} />
          <div className="spn-arm">
            <div className="spn-arm-h">
              <span className="spn-arm-r display">{sec.roman}</span>
              <div>
                <div className="spn-arm-n">{sec.name}</div>
                <div className="spn-arm-b">{sec.blurb}</div>
              </div>
            </div>
            <div className="spn-arm-k">
              <div>
                <span className="label">agents</span>
                <span className="num">{live ? onArm : DASH}</span>
              </div>
              <div>
                <span className="label">pages</span>
                <span className="num">{fmtInt(info?.pages)}</span>
              </div>
              <div>
                <span className="label">frontier</span>
                <span className="num">{fmtInt(info?.frontier)}</span>
              </div>
            </div>
          </div>
        </fieldset>

        <div className="spn-field">
          <label className="label" htmlFor={`${ids}-name`}>
            <span className="hot">02</span> · name it
          </label>
          <div className={`spn-input ${showProblem ? 'bad' : ''} ${!live ? 'off' : ''}`}>
            <span className="spn-pre num" aria-hidden="true">
              {code}
            </span>
            <input
              id={`${ids}-name`}
              name="name"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={16}
              placeholder="e.g. lanternfish"
              value={name}
              disabled={!live}
              aria-invalid={showProblem ? true : undefined}
              aria-describedby={hintId}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
              onBlur={() => setTouched(true)}
            />
            <span className="spn-len num" aria-hidden="true">
              {name.length}/16
            </span>
          </div>
          <p id={hintId} className={`spn-hint ${showProblem ? 'err' : ''}`}>
            {showProblem ? problem : taken ? `"${name}" already exists — names may repeat, codes never do` : '2–16 characters: a–z, 0–9 and - · its code will be ' + code}
          </p>
        </div>

        <div className="spn-field">
          <span className="label" id={`${ids}-owner`}>
            <span className="hot">03</span> · credited to
          </span>
          <div className="spn-owner" aria-labelledby={`${ids}-owner`}>
            <span className={`spn-owner-v num ${address ? '' : 'dim'}`}>{address ? shortAddr(address) : 'anon'}</span>
          </div>
          <p className="spn-hint">
            The owner field is a public label only: your connected wallet address if there is one, otherwise “anon”. Spawned agents earn no INK; to earn,{' '}
            <Link to="/node">plug in a GPU</Link>. Spawning needs no wallet, no signature and no transaction.
          </p>
        </div>

        <button type="submit" className="btn primary lg spn-go" disabled={!canSubmit}>
          {!live ? 'waiting for server' : status.kind === 'sending' ? 'spawning…' : cooling > 0 ? `next spawn in ${cooling}s` : full ? `limit · ${MAX_AGENTS} agents` : `spawn ${code} →`}
        </button>

        <div id={statusId} className="spn-status" role="status" aria-live="polite">
          {status.kind === 'error' && (
            <p className="spn-err">
              <span className="label">refused</span> {status.msg}
            </p>
          )}
          {full && live && status.kind !== 'error' && (
            <p className="spn-err">
              <span className="label">full</span> the swarm is at its {MAX_AGENTS}-agent limit.
            </p>
          )}
        </div>
      </form>

      {spawned && (
        <div className="spn-card" aria-live="polite">
          <div className="spn-card-top">
            <span className="tag solid">SPAWNED</span>
            <StatePill state={spawned.state} />
          </div>
          <div className="spn-card-id">
            <span className="spn-card-code display">{spawned.code}</span>
            <div>
              <div className="spn-card-n">{spawned.name}</div>
              <div className="label">
                arm {SECTORS[spawned.sector].roman} · {SECTORS[spawned.sector].name} · slot {spawned.slot + 1}
              </div>
            </div>
          </div>
          <div className="spn-card-u mono">{spawned.url ? spawned.url.replace(/^https?:\/\//, '') : 'picking its first page…'}</div>
          <Link to={`/agents/${spawned.id}`} className="btn spn-card-go">
            open its history →
          </Link>
        </div>
      )}

      <div className="spn-hand">
        <div className="spn-hand-h">
          <span className="label">spawned by people</span>
          <span className="label num">{live ? byHand.length : DASH}</span>
        </div>
        {!live ? (
          <p className="spn-hint">{CONN_TEXT[conn]}</p>
        ) : byHand.length === 0 ? (
          <p className="spn-hint">No spawned agents yet — every agent so far is built-in.</p>
        ) : (
          <ul className="spn-hand-l">
            {byHand.slice(0, 8).map((a) => (
              <li key={a.id}>
                <Link to={`/agents/${a.id}`} className="spn-hand-r">
                  <span className="num">{a.code}</span>
                  <span>{a.name}</span>
                  <span className="dimmer">{a.owner && a.owner.length > 14 ? shortAddr(a.owner) : (a.owner ?? 'anon')}</span>
                  <span className="num">{fmtInt(a.pages)} pg</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
