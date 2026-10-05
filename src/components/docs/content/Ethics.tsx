import { CRAWL, ROBOTS_TOKEN, USER_AGENT } from '../facts'
import { C, Callout, Code, CopyButton, H3, Src, Table } from '../ui'

export function Ethics() {
  return (
    <>
      <p className="dlead">
        LUSCA fetches other people’s servers. The rules below are enforced in code, per request, for every agent. Where something is planned rather than
        enforced, it says so.
      </p>

      <H3 id="ethics-identity" n="4.1">
        Identity
      </H3>
      <p>Every request — pages and robots.txt alike — carries this exact user agent:</p>
      <div className="dua">
        <code className="dua-s mono">{USER_AGENT}</code>
        <CopyButton text={USER_AGENT} />
      </div>
      <p>
        robots.txt groups are matched against the token <C>{ROBOTS_TOKEN}</C> (the parser lowercases it and ignores the version). Pages also request{' '}
        <C>Accept: text/html,application/xhtml+xml</C> and <C>Accept-Language: en-US</C>. LUSCA does not rotate user agents, spoof browsers or use
        proxies.
      </p>
      <Src path="server/ingest/util.ts · fetcher.ts" />

      <H3 id="ethics-robots" n="4.2">
        robots.txt
      </H3>
      <p>
        Before the first page on an origin, the agent fetches <C>/robots.txt</C> ({CRAWL.robotsTimeoutS} s timeout, {CRAWL.robotsMaxKB} KB cap) and
        caches the result for {CRAWL.robotsTtlMin} minutes. What happens next depends on the answer:
      </p>
      <Table label="robots.txt outcomes">
        <thead>
          <tr>
            <th>response</th>
            <th>treated as</th>
            <th>effect</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="mono">2xx, text</td>
            <td className="strong">rules</td>
            <td>Parsed with robots-parser; Allow, Disallow and the delay directive for LuscaBot (or <C>*</C>) apply to every URL on the origin.</td>
          </tr>
          <tr>
            <td className="mono">2xx, HTML page</td>
            <td>no rules</td>
            <td>A site that answers robots.txt with an HTML page has published no rules; everything is allowed.</td>
          </tr>
          <tr>
            <td className="mono">4xx (not 429)</td>
            <td>allow all</td>
            <td>The standard reading of a missing robots.txt.</td>
          </tr>
          <tr>
            <td className="mono">429 · 5xx · timeout · network error</td>
            <td className="strong">unavailable</td>
            <td>
              No page is fetched. The host is paused for {CRAWL.robotsPauseMin} minutes, then robots.txt is tried again.
            </td>
          </tr>
        </tbody>
      </Table>
      <ul className="dlist">
        <li>
          <b>Redirects are re-checked.</b> Pages are fetched with <C>redirect: manual</C>; every hop to a new origin (including http → https) gets its
          own robots.txt check before it is followed.
        </li>
        <li>
          <b>Disallowed links are never queued</b> once the host’s robots.txt is cached, so they do not even occupy frontier slots.
        </li>
        <li>
          <b>Page-level directives.</b> <C>{'<meta name="robots">'}</C> or <C>{'<meta name="luscabot">'}</C> with <C>noindex</C> (or <C>none</C>): the
          page is dropped and not stored. With <C>nofollow</C>: its links are not harvested. The <C>X-Robots-Tag</C> response header is honored the
          same way.
        </li>
      </ul>

      <H3 id="ethics-politeness" n="4.3">
        Politeness
      </H3>
      <Table label="Per-host politeness rules">
        <thead>
          <tr>
            <th>rule</th>
            <th className="r">value</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>requests in flight per host</td>
            <td className="r num strong">1</td>
            <td>A host is claimed atomically before a request and released after. Agents on different arms share the same host table.</td>
          </tr>
          <tr>
            <td>interval between requests</td>
            <td className="r num strong">max({CRAWL.minIntervalMs} ms, robots.txt delay)</td>
            <td>Measured from the end of the previous request. A robots.txt fetch counts: the agent waits one full interval before the first page.</td>
          </tr>
          <tr>
            <td>request timeout</td>
            <td className="r num strong">{CRAWL.pageTimeoutS} s</td>
            <td>Per hop. Each redirect hop is its own request with its own budget.</td>
          </tr>
          <tr>
            <td>redirects</td>
            <td className="r num strong">≤ {CRAWL.maxRedirects}</td>
            <td>
              If a redirect points to a host that is busy, the agent waits at most {CRAWL.redirectWaitS} s, then hands the URL back to the frontier
              instead of queueing behind the host.
            </td>
          </tr>
          <tr>
            <td>429 / 503</td>
            <td className="r num strong">
              {CRAWL.retryAfterMinS} s – {CRAWL.retryAfterMaxMin} min
            </td>
            <td>Host paused for <C>Retry-After</C>, clamped to that range (60 s when absent).</td>
          </tr>
          <tr>
            <td>consecutive errors</td>
            <td className="r num strong">
              {CRAWL.errorsBeforeBackoff} → {CRAWL.errorBackoffMin} min
            </td>
            <td>Network failures, 5xx, 429 and 403 count. Three in a row pause the host for five minutes. A success resets the count.</td>
          </tr>
        </tbody>
      </Table>
      <Src path="server/ingest/hosts.ts · pipeline.ts (fetchStage)" />

      <H3 id="ethics-scope" n="4.4">
        What gets fetched
      </H3>
      <ul className="dlist">
        <li>
          <b>HTML only.</b> <C>text/html</C> or <C>application/xhtml+xml</C>; a response without a content type is accepted only if its first kilobyte
          looks like HTML. Everything else is cancelled after the headers.
        </li>
        <li>
          <b>{CRAWL.maxBodyMB} MB body cap.</b> The stream is cut at 2 MB and the rest is never downloaded.
        </li>
        <li>
          <b>No JavaScript.</b> Pages with fewer than {CRAWL.minWords} words of readable text are dropped as probably client-rendered.
        </li>
        <li>
          <b>Never queued:</b> non-page extensions (pdf, images, archives, js, css, json, xml, feeds, source files…), raw IPs, <C>localhost</C>, URLs
          with credentials, WordPress internals, MediaWiki special namespaces and edit/history/diff views. Tracking parameters (<C>utm_*</C>,{' '}
          <C>fbclid</C>, <C>gclid</C>, <C>ref</C>…) are stripped before a URL is queued.
        </li>
        <li>
          <b>Bounded.</b> Frontier ≤ {CRAWL.globalCap.toLocaleString('en-US')} URLs, ≤ {CRAWL.perHostCap} per host, link depth ≤ {CRAWL.maxDepth} hops
          from a seed, ≤ {CRAWL.maxLinksPerPage} new links taken per page.
        </li>
      </ul>

      <H3 id="ethics-domains" n="4.5">
        New domains
      </H3>
      <p>
        Agents may admit hosts beyond the seeds, under four limits: a link to an unknown host needs frontier priority ≥ {CRAWL.newHostMinPriority} (vs{' '}
        {CRAWL.knownHostMinPriority} for known hosts); at most {CRAWL.maxNewHostsPerPage} new hosts per page; a token bucket of {CRAWL.admitBurst}{' '}
        admissions refilling one per {CRAWL.admitRefillS} s; and a hard cap of {CRAWL.maxAdmittedHosts} admitted hosts per process.
      </p>
      <p>
        A blocklist keeps social, auth and mega-platform hosts out entirely: X/Twitter, Facebook, Instagram, Telegram, Discord, YouTube, Reddit,
        LinkedIn, TikTok, GitHub, GitLab, Google properties, archive.org, URL shorteners, Medium member pages, Notion, Figma, Stack Overflow, package
        registries, and any <C>accounts.</C> / <C>login.</C> / <C>auth.</C> / <C>signin.</C> subdomain.
      </p>
      <Src path="server/ingest/url.ts (BLOCKED_HOSTS, skipReason) · pipeline.ts (enqueueLinks)" />

      <H3 id="ethics-optout" n="4.6">
        Opting out
      </H3>
      <p>To block LUSCA from a whole site, add this to your robots.txt:</p>
      <Code lang="robots" title="robots.txt">{`User-agent: LuscaBot
Disallow: /`}</Code>
      <p>To slow it down instead, set <C>Crawl-delay</C> in seconds; LUSCA uses it as the minimum interval between requests:</p>
      <Code lang="robots" title="robots.txt">{`User-agent: LuscaBot
Crawl-delay: 10`}</Code>
      <p>For a single page, either of these keeps it out of the dataset:</p>
      <Code lang="html" title="html / http">{`<meta name="luscabot" content="noindex, nofollow">
X-Robots-Tag: noindex`}</Code>
      <Callout kind="note" title="timing">
        robots.txt is cached for up to {CRAWL.robotsTtlMin} minutes per origin, so a change takes effect within the hour on a running server. Pages
        already stored stay in <C>dataset.jsonl</C> until removed by the operator; deletion requests go to the operator of the instance that fetched your pages.
      </Callout>

      <H3 id="ethics-licenses" n="4.7">
        Licenses and provenance
      </H3>
      <p>
        Public is not the same as unlicensed. Several crypto forums publish posts under explicit content licenses — ethresear.ch, for example, uses CC
        BY-NC-SA, which forbids commercial reuse. Discourse’s stock terms of service permit automated access for the purpose of public search indexes; a training
        dataset is a different use, and the license of the underlying posts still applies.
      </p>
      <p>
        <b>What the code does today:</b> every line of <C>dataset.jsonl</C> records the page’s <C>url</C>, <C>host</C>, <C>sector</C> and fetch time{' '}
        <C>ts</C>. That provenance is enough to exclude every page from a given host — for example all non-commercially licensed forums — when a dataset
        is cut for a commercial license.
      </p>
      <Callout kind="roadmap" title="enforced license filter">
        A per-host license table and an export step that refuses to place NC-licensed hosts into a commercially licensed dataset, with an attribution
        manifest for share-alike sources. Not built yet.
      </Callout>
      <Callout kind="honest">
        Nothing in the current code distinguishes licenses. The agents do not read license notices, and SEPIA-0 trains on every accepted page
        regardless of host. Per-link <C>rel="nofollow"</C> is not used to skip individual links (page-level nofollow is).
      </Callout>
    </>
  )
}
