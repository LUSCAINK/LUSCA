import { Link } from 'react-router-dom'
import { SECTORS } from '@shared/sectors'
import { CRAWL } from '../facts'
import { C, Callout, H3, Src, Table } from '../ui'

const seedLabel = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '')

export function Arms() {
  const seedCount = SECTORS.reduce((n, s) => n + s.seeds.length, 0)
  return (
    <>
      <p className="dlead">
        Ingest is split into eight arms. An arm is a sector of the crypto web with its own seed pages, its own host rules and a relevance prior that
        tilts the taste score for its seed hosts. {seedCount} seed pages in total; all of them are server-rendered pages that an agent without JavaScript can
        read.
      </p>

      <H3 id="arms-table" n="3.1">
        The eight
      </H3>
      <Table label="The eight arms" className="dt-arms">
        <thead>
          <tr>
            <th>arm</th>
            <th>name</th>
            <th>blurb</th>
            <th>seed pages</th>
            <th className="r">prior</th>
          </tr>
        </thead>
        <tbody>
          {SECTORS.map((s) => (
            <tr key={s.id}>
              <td className="num hot strong">{s.roman}</td>
              <td className="strong">{s.name}</td>
              <td>{s.blurb}</td>
              <td>
                <ul className="dseeds mono">
                  {s.seeds.map((u) => (
                    <li key={u}>{seedLabel(u)}</li>
                  ))}
                </ul>
              </td>
              <td className="r num strong">{s.prior.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Src path="shared/sectors.ts — rendered from SECTORS at build time" />

      <H3 id="arms-assign" n="3.2">
        How a URL finds its arm
      </H3>
      <ol className="dsteps">
        <li>
          <b>Seed path prefix.</b> If the host carries seeds, the longest seed path that prefixes the URL wins. <C>ethereum.org/en/developers/docs/…</C>{' '}
          goes to III Docs; <C>ethereum.org/en/learn/…</C> goes to VI Codex.
        </li>
        <li>
          <b>Known host.</b> Otherwise the arm recorded for that host when it was first seen.
        </li>
        <li>
          <b>Host rules.</b> Otherwise the first sector whose rule matches the hostname (table below, checked in arm order).
        </li>
        <li>
          <b>Inheritance.</b> Otherwise the arm of the page that linked to it.
        </li>
      </ol>
      <Table label="Host rules, first match wins">
        <thead>
          <tr>
            <th>arm</th>
            <th>hostname rules (regular expressions, checked in order)</th>
          </tr>
        </thead>
        <tbody>
          {SECTORS.map((s) => (
            <tr key={s.id}>
              <td className="num hot strong">{s.roman}</td>
              <td className="mono small">
                {s.hostRules.map((r, i) => (
                  <span key={i} className="drule">
                    /{r.source}/
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      <H3 id="arms-agents" n="3.3">
        Suckers on an arm
      </H3>
      <p>
        Genesis agents are dealt round-robin: agent <i>i</i> lives on arm <i>i</i> mod 8 at slot ⌊<i>i</i>/8⌋, so the default {CRAWL.defaultAgents}{' '}
        gives three per arm. Each runs one loop — <C>seek → fetch → parse → taste → dedupe → store</C>, or <C>reject</C> / <C>error</C> /{' '}
        <C>sleep</C> — forever. Users can spawn more onto an arm through <C>POST /api/spawn</C> (one per 10 s per IP) up to {CRAWL.maxAgents} agents in
        total.
      </p>
      <p>
        An agent always prefers its own arm. When none of its arm’s hosts are ready — empty, or every host cooling under politeness rules — it steals the
        best ready URL from any other arm, and says so in its trace (<C>stolen from arm IV (own arm cooling)</C>). Arms with many hosts therefore stay
        busy without any arm hammering one site.
      </p>

      <H3 id="arms-prior" n="3.4">
        Host prior
      </H3>
      <p>
        The prior enters two formulas: 25% of the taste score and 20% of a link’s frontier priority (<Link to="/docs/taste">05 · taste</Link>). It
        only applies to seed hosts — the hosts listed above. Every host admitted later by an agent gets a neutral prior of <C>0.50</C>, whatever arm it
        lands on.
      </p>
      <Callout kind="note">
        Priors are fixed numbers set by hand in <C>shared/sectors.ts</C>, not learned. They express how much on-topic text a sector’s seed hosts tend to
        carry: research forums (0.90) more than dashboards (0.70) or a general encyclopedia (0.60).
      </Callout>
    </>
  )
}
