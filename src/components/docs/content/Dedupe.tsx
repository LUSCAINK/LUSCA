import { Link } from 'react-router-dom'
import { VEC_DIM } from '@shared/vectorize'
import { CRAWL, NEURON } from '../facts'
import { C, Callout, Formula, H3, Src, Table } from '../ui'

/** 64-bit SimHash band layout, drawn as 4 × 16 cells. */
function Bands() {
  const bands = ['lo & 0xffff', 'lo >>> 16', 'hi & 0xffff', 'hi >>> 16']
  return (
    <div className="dbands" aria-label="SimHash split into four 16-bit bands">
      {bands.map((b, i) => (
        <div className="dband" key={b}>
          <div className="dband-bits">
            {Array.from({ length: 16 }, (_, k) => (
              <span key={k} className={(i * 7 + k * 3) % 5 < 2 ? 'on' : ''} />
            ))}
          </div>
          <div className="dband-l mono">
            <span className="hot">band {i}</span> · {b}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Dedupe() {
  return (
    <>
      <p className="dlead">
        Four filters, cheapest first. The first three run inline in every agent before a page is stored. The fourth runs on volunteer GPUs after the
        fact and only flags.
      </p>
      <Table label="Dedupe layers">
        <thead>
          <tr>
            <th className="r">#</th>
            <th>layer</th>
            <th>key</th>
            <th>catches</th>
            <th>action</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="r num">1</td>
            <td className="strong">revisit</td>
            <td className="mono small">sha1(normalized url)[0:16]</td>
            <td>the same URL, or its same-host canonical</td>
            <td>reject (links still harvested)</td>
          </tr>
          <tr>
            <td className="r num">2</td>
            <td className="strong">exact</td>
            <td className="mono small">sha1(cleaned text)</td>
            <td>byte-identical text under another URL</td>
            <td>reject</td>
          </tr>
          <tr>
            <td className="r num">3</td>
            <td className="strong">near</td>
            <td className="mono small">simhash64(text)</td>
            <td>mirrors, reposts, template-identical pages, small edits</td>
            <td>reject at hamming ≤ {CRAWL.nearDupHamming}</td>
          </tr>
          <tr>
            <td className="r num">4</td>
            <td className="strong hot">vector</td>
            <td className="mono small">
              cosine of {VEC_DIM}-dim hashed BoW
            </td>
            <td>same content, different wording or layout</td>
            <td>flag at cosine ≥ {NEURON.dupThreshold}</td>
          </tr>
        </tbody>
      </Table>

      <H3 id="dedupe-ids" n="6.1">
        Revisits and exact copies
      </H3>
      <p>
        URL identity uses a normalized key: lowercase host, no fragment, no default port, tracking parameters removed, query parameters sorted, trailing
        slash dropped, and Discourse post permalinks (<C>/t/slug/123/45</C>) collapsed to the topic (<C>/t/slug/123</C>). The page id is the first 16
        hex digits of its SHA-1. If the page declares a same-host <C>{'<link rel="canonical">'}</C>, that id is checked too. Exact copies are caught by
        SHA-1 of the cleaned text (first {CRAWL.maxTextChars.toLocaleString('en-US')} characters).
      </p>

      <H3 id="dedupe-simhash" n="6.2">
        64-bit SimHash
      </H3>
      <Formula
        label="simhash64(text) — server/ingest/simhash.ts"
        rows={[
          ['words', 'lowercase [a-z0-9]+ runs, ≤ 25,000', ''],
          ['shingles', 'every 3 consecutive words', 'unigrams if fewer than 3 words'],
          ['h(s)', 'FNV-1a 64 + murmur-style finalizer', '64 well-mixed bits per shingle'],
          ['v[b]', 'Σ over shingles of (bit b of h(s) ? +1 : −1)', 'b = 0 … 63'],
          ['simhash', 'bit b set ⇔ v[b] > 0', ''],
        ]}
      />
      <p>
        Two pages are near-duplicates when their hashes differ in at most {CRAWL.nearDupHamming} of 64 bits (≥ 95.3% agreement). For scale: changing two
        words in the 358-word example from <Link to="/docs/taste">05</Link> moves its hash by 1 bit; an unrelated page sits around 32.
      </p>
      <p>
        <b>Index.</b> Each hash is filed under its four 16-bit bands. By pigeonhole, two hashes within distance 3 differ in at most three bands, so
        they agree exactly on at least one: looking up the four buckets finds every candidate within the threshold. The lookup is exact for{' '}
        <C>k = 3</C>, not approximate.
      </p>
      <Bands />
      <p>
        The trace also reports the true nearest distance among the newest 20,000 hashes (<C>nearest hamming 17 → unique</C>), so you can see how close a
        page came.
      </p>

      <H3 id="dedupe-semantic" n="6.3">
        GPU vector pass
      </H3>
      <p>
        SimHash only sees shared word sequences. Two write-ups of the same exploit in different words pass it. That gap is the work neurons do. Every
        stored page also gets a {VEC_DIM}-dimensional vector, identical on server and browser:
      </p>
      <Formula
        label="vectorize(title + '\n' + text) — shared/vectorize.ts"
        rows={[
          ['words', 'lowercase tokens ≥ 2 chars, 105 stopwords removed, ≤ 6,000', ''],
          ['features', 'each word (weight 1) + each adjacent bigram (weight 0.5)', ''],
          ['index', 'fnv1a32(feature) mod 256', 'feature hashing'],
          ['sign', 'bit 31 of the hash ? −1 : +1', 'signed, to cancel collisions'],
          ['v[i]', 'sign(x) · ln(1 + |x|)', 'log-scaled term frequency'],
          ['vector', 'v / ‖v‖₂', 'unit length, so dot = cosine'],
        ]}
      />
      <p>
        A job compares the newest page vectors (rows) against a block of the corpus (columns, from a cursor that cycles through the newest{' '}
        {CRAWL.memoryPages.toLocaleString('en-US')} pages), excluding the row pages themselves. For each row the neuron returns the best column and its
        cosine. The coordinator verifies the result (<Link to="/docs/neurons">08</Link>), then re-computes the cosine of every candidate pair on the CPU;
        pairs at ≥ {NEURON.dupThreshold} are reported to the ingest pipeline as near-duplicates (a word-vector match, not a meaning match).
      </p>
      <Callout kind="honest" title="flag, not delete">
        A semantic flag is recorded — in <C>ingest-state.json</C>, the dupes counter and a trace on the agent that stored the page — but the page is{' '}
        <b>not</b> removed from <C>dataset.jsonl</C> or from SEPIA’s corpus. It was already accepted. Hashed bag-of-words vectors are a crude semantic
        signal: they match shared vocabulary, not meaning.
      </Callout>
      <Callout kind="roadmap">Export filters that drop flagged pages when a dataset snapshot is cut; learned embeddings once neurons can run them.</Callout>
      <Src path="server/ingest/pipeline.ts (dedupe stage, markSemanticDup) · simhash.ts · shared/vectorize.ts" />
    </>
  )
}
