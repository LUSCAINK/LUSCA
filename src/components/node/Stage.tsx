import type { ReactNode } from 'react'

export type StageState = 'locked' | 'ready' | 'busy' | 'done'

const STATE_LABEL: Record<StageState, string> = {
  locked: 'waiting',
  ready: 'ready',
  busy: 'working',
  done: 'done',
}

/** Page section header: mono kicker, plain display title, optional one-line summary. */
export function SecHead({ id, kicker, title, sub, children }: { id: string; kicker: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="sec-head">
      <p className="sec-k mono">
        <span className="sec-i" aria-hidden="true">
          ■
        </span>
        {kicker}
      </p>
      <h2 id={id} className="display">
        {title}
      </h2>
      {sub && <p className="sec-sub">{sub}</p>}
      {children}
    </header>
  )
}

/** One numbered step in Details: index, plain title, one-line kicker, state pill, lock note. */
export function Stage({
  id,
  n,
  title,
  kicker,
  state,
  lockedNote,
  children,
}: {
  id: string
  n: string
  title: string
  kicker: string
  state: StageState
  lockedNote?: string
  children: ReactNode
}) {
  const locked = state === 'locked'
  return (
    <section id={id} className={`nd-stage st-${state}`} aria-labelledby={`${id}-h`}>
      <header className="st-head">
        <div className="st-num display" aria-hidden="true">
          {n}
        </div>
        <div className="st-title">
          <h3 id={`${id}-h`} className="display">
            <span className="sr-only">Step {n}: </span>
            {title}
          </h3>
          <p className="st-kick">{kicker}</p>
        </div>
        <div className="st-state">
          <span className={`st-pill st-pill-${state}`}>
            <span className={`led ${state === 'busy' ? 'on pulse' : state === 'done' ? 'white' : ''}`} aria-hidden="true" />
            {STATE_LABEL[state]}
          </span>
        </div>
      </header>
      {locked && (
        <div className="st-lock mono" role="note">
          <span className="st-lock-i" aria-hidden="true">
            ▮
          </span>
          <span>{lockedNote ?? 'waiting for the step above'}</span>
        </div>
      )}
      <div className="st-body" inert={locked}>
        {children}
      </div>
    </section>
  )
}

/** Labelled sub-panel inside a stage. */
export function Cell({ idx, title, meta, className, children }: { idx: string; title: string; meta?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={`nd-cell ${className ?? ''}`}>
      <div className="panel-head">
        <span>
          <span className="hot">{idx}</span>&nbsp;&nbsp;<b>{title}</b>
        </span>
        {meta !== undefined && <span className="nd-meta">{meta}</span>}
      </div>
      {children}
    </div>
  )
}
