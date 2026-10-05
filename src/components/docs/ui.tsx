// Manual primitives: inline code, numbered sub-headings, callouts, tables,
// formula blocks and copyable code blocks with a tiny, dependency-free highlighter.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'

/** Inline code chip. */
export function C({ children }: { children: ReactNode }) {
  return <code className="dc">{children}</code>
}

/** Numbered sub-heading; the on-this-page index is built from these. */
export function H3({ id, n, children }: { id: string; n: string; children: ReactNode }) {
  return (
    <h3 id={id} className="dh3" data-n={n}>
      <span className="dh3-n num">{n}</span>
      <span className="dh3-t">{children}</span>
    </h3>
  )
}

const CALLOUT_LABEL = { note: 'note', roadmap: 'roadmap', honest: 'honest' } as const

/** NOTE (plain fact) · ROADMAP (not built yet) · HONEST (a limitation, stated plainly). */
export function Callout({ kind, title, children }: { kind: keyof typeof CALLOUT_LABEL; title?: string; children: ReactNode }) {
  return (
    <aside className={`dcall dcall-${kind}`}>
      <div className="dcall-k mono">
        <span className="dcall-tag">{CALLOUT_LABEL[kind]}</span>
        {title && <span className="dcall-title">{title}</span>}
      </div>
      <div className="dcall-b">{children}</div>
    </aside>
  )
}

/** Scroll container for wide tables: the table scrolls, never the page. */
export function Table({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="dt-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className={`dt ${className ?? ''}`}>{children}</table>
    </div>
  )
}

/** Source pointer: where a number or rule lives in the code. */
export function Src({ path }: { path: string }) {
  return (
    <div className="dsrc mono">
      <span className="dsrc-k">src</span>
      <span>{path}</span>
    </div>
  )
}

/** Aligned formula block: [lhs, rhs, comment?] rows. */
export function Formula({ rows, label }: { rows: [string, string, string?][]; label?: string }) {
  return (
    <div className="dfx" role="figure" aria-label={label ?? 'formula'}>
      {label && <div className="dfx-head label">{label}</div>}
      <div className="dfx-body">
        {rows.map(([l, r, c], i) => (
          <div className="dfx-row" key={i}>
            <span className="dfx-l">{l}</span>
            <span className="dfx-eq">=</span>
            <span className="dfx-r">{r}</span>
            {c ? <span className="dfx-c">{c}</span> : <span />}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── code blocks ─────────────────────────────────────────── */

type Lang = 'bash' | 'json' | 'robots' | 'text' | 'html'

function hlJson(src: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push(src.slice(last, m.index))
    if (m[1]) {
      out.push(
        <span key={k++} className={m[2] ? 'tk-k' : 'tk-s'}>
          {m[1]}
        </span>,
      )
      if (m[2]) out.push(m[2])
    } else if (m[3]) {
      out.push(
        <span key={k++} className="tk-n">
          {m[3]}
        </span>,
      )
    } else {
      out.push(
        <span key={k++} className="tk-l">
          {m[4]}
        </span>,
      )
    }
    last = re.lastIndex
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

function hlShell(src: string): ReactNode[] {
  const lines = src.split('\n')
  return lines.map((line, i) => {
    const hash = line.search(/(^|\s)#/)
    const code = hash >= 0 ? line.slice(0, hash) : line
    const com = hash >= 0 ? line.slice(hash) : ''
    const parts: ReactNode[] = []
    const toks = code.split(/(\s+)/)
    let cmdSeen = false
    toks.forEach((t, j) => {
      if (!t || /^\s+$/.test(t)) {
        parts.push(t)
        return
      }
      if (!cmdSeen && /^[A-Z_][A-Z0-9_]*=/.test(t)) {
        parts.push(
          <span key={j} className="tk-env">
            {t}
          </span>,
        )
        return
      }
      if (!cmdSeen) {
        cmdSeen = true
        parts.push(
          <span key={j} className="tk-cmd">
            {t}
          </span>,
        )
        return
      }
      if (/^--?[a-z]/i.test(t)) {
        parts.push(
          <span key={j} className="tk-flag">
            {t}
          </span>,
        )
        return
      }
      parts.push(t)
    })
    return (
      <Fragment key={i}>
        {parts}
        {com && <span className="tk-c">{com}</span>}
        {i < lines.length - 1 ? '\n' : ''}
      </Fragment>
    )
  })
}

function hlRobots(src: string): ReactNode[] {
  const lines = src.split('\n')
  return lines.map((line, i) => {
    const m = /^(\s*)([A-Za-z-]+:)(.*)$/.exec(line)
    const hash = line.indexOf('#')
    return (
      <Fragment key={i}>
        {hash === 0 ? (
          <span className="tk-c">{line}</span>
        ) : m ? (
          <>
            {m[1]}
            <span className="tk-k">{m[2]}</span>
            <span className="tk-s">{m[3]}</span>
          </>
        ) : (
          line
        )}
        {i < lines.length - 1 ? '\n' : ''}
      </Fragment>
    )
  })
}

function highlight(src: string, lang: Lang): ReactNode {
  if (lang === 'json') return hlJson(src)
  if (lang === 'bash') return hlShell(src)
  if (lang === 'robots') return hlRobots(src)
  return src
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** Copy button with a short "copied" state. */
export function CopyButton({ text, label = 'copy', className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={`dcopy ${state === 'ok' ? 'ok' : ''} ${className ?? ''}`}
      onClick={async () => {
        const ok = await copyText(text)
        setState(ok ? 'ok' : 'fail')
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setState('idle'), 1400)
      }}
      aria-label={`${label} to clipboard`}
    >
      <span className="dcopy-led" aria-hidden="true" />
      {state === 'ok' ? 'copied' : state === 'fail' ? 'press ctrl+c' : label}
    </button>
  )
}

/** Copyable code block. `children` is the literal text that gets copied. */
export function Code({ children, lang = 'bash', title, copy = true }: { children: string; lang?: Lang; title?: string; copy?: boolean }) {
  const text = children.replace(/^\n+|\s+$/g, '')
  return (
    <div className="dcode">
      <div className="dcode-head">
        <span className="dcode-lang mono">{title ?? lang}</span>
        {copy && <CopyButton text={text} />}
      </div>
      <pre className="dcode-pre" tabIndex={0}>
        <code>{highlight(text, lang)}</code>
      </pre>
    </div>
  )
}

/** Mono definition grid for short spec lists. */
export function Spec({ rows }: { rows: [ReactNode, ReactNode, ReactNode?][] }) {
  return (
    <dl className="dspec">
      {rows.map(([k, v, s], i) => (
        <div className="dspec-row" key={i}>
          <dt>{k}</dt>
          <dd>
            <span className="dspec-v">{v}</span>
            {s && <span className="dspec-s">{s}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
