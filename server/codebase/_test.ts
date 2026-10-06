// Protocol code index tests: synthetic tar.gz archives built in-test, no network.
//   npx tsx server/codebase/_test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { readTar, writeTar, TarError, type TarEntry, type TarWriteEntry } from './tar.ts'
import {
  canonicalExpr,
  combineLicenseFiles,
  detectLicenseExpr,
  detectLicenseText,
  exprTier,
  forbidsMachineLearning,
  isLicenseFile,
  isReadme,
  licenseMatches,
  resolveRepoLicense,
  spdxHeader,
} from './licenses.ts'
import { LARGE_FILE_BYTES, MAX_FILE_BYTES, contentReject, decodeText, fileLimit, langOf, licenseDirInScope, pathInScope } from './filters.ts'
import { ArchiveTooLarge, HttpStatusError, findRefInAdvertisement, githubSource, inflateArchive, parseRetryAfter, type ArchiveSource } from './source.ts'
import { indexArchive, readShard, type CodeRecord } from './ingest.ts'
import { createCodeIndexWith, isTransient, publicNote, type CodeIndexInternals } from './index.ts'
import { REPOS, type RepoSpec } from './repos.ts'

let passed = 0
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n${(e as Error).stack}`)
    process.exitCode = 1
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'lusca-code-'))
let dirN = 0
const freshDir = () => {
  const d = join(tmp, `d${dirN++}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** Feed a buffer in random-size chunks (exercises block boundaries). */
function* chunked(buf: Buffer, seed = 7): Generator<Buffer> {
  let s = seed
  let off = 0
  while (off < buf.length) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    const n = 1 + (s % 1500)
    yield buf.subarray(off, Math.min(buf.length, off + n))
    off += n
  }
}

const MIT_TEXT = `MIT License\n\nCopyright (c) 2024\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction...`
const APACHE_TEXT = `                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n`
const BUSL_TEXT = `Business Source License 1.1\n\nLicense text copyright (c) 2017 MariaDB Corporation Ab, All Rights Reserved.\n"Business Source License" is a trademark of MariaDB Corporation Ab.\n`
const GPL3_TEXT = `                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n`
const AGPL_NOTICE = `Copyright (C) 2020 Aave\n\nThis program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or any later version.`
const LGPL3_TEXT = `                   GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n\n  This version of the GNU Lesser General Public License incorporates\nthe terms and conditions of version 3 of the GNU General Public\nLicense, supplemented by the additional permissions listed below.\n`

const sol = (name: string, spdx: string | null, extra = '') =>
  `${spdx ? `// SPDX-License-Identifier: ${spdx}\n` : ''}pragma solidity ^0.8.20;\r\n\r\ncontract ${name} {\r\n    uint256 public x; ${extra}\r\n}\r\n`

/** Rewrite the size field of the first ustar header in `tar` and fix its checksum. */
function patchFirstHeader(tar: Buffer, patch: (h: Buffer) => void): Buffer {
  const out = Buffer.from(tar)
  const h = out.subarray(0, 512)
  patch(h)
  h.fill(0x20, 148, 156)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return out
}

// ─── tar ────────────────────────────────────────────────────────────────────

await test('tar: ustar, pax long names, GNU long names, prefix split, global header, chunk boundaries', async () => {
  const long = 'repo-abc/' + 'deep/'.repeat(30) + 'VeryLongContractName.sol' // > 155 bytes
  const longGnu = 'repo-abc/' + 'gnu/'.repeat(40) + 'G.rs'
  const longPrefix = 'repo-abc/' + 'p/'.repeat(60) + 'Short.sol' // 9 + 120 + 9 → splits at a '/' within 155
  const big = Buffer.alloc(300_000, 0x61)
  const entries: TarWriteEntry[] = [
    { path: 'repo-abc/', type: 'dir' },
    { path: 'repo-abc/a.sol', body: 'contract A {}\n' },
    { path: 'repo-abc/empty.md', body: '' },
    { path: 'repo-abc/big.bin', body: big },
    { path: long, body: 'pax long\n', longMode: 'pax' },
    { path: longGnu, body: 'gnu long\n', longMode: 'gnu' },
    { path: longPrefix, body: 'prefix long\n', longMode: 'prefix' },
    { path: 'repo-abc/link', type: 'symlink', linkPath: 'a.sol' },
    { path: 'repo-abc/z.txt', body: 'x'.repeat(513) },
  ]
  const tar = writeTar(entries, { comment: 'f'.repeat(40) })
  for (const seed of [1, 2, 3, 99]) {
    const seen: Record<string, string> = {}
    const types: Record<string, string> = {}
    let comment = ''
    await readTar(chunked(tar, seed), {
      global: (r) => (comment = r.comment),
      want: (e: TarEntry) => {
        types[e.path] = e.type
        return !e.path.endsWith('.bin')
      },
      file: (e, body) => {
        seen[e.path] = body.toString('utf8')
      },
    })
    assert.equal(comment, 'f'.repeat(40))
    assert.equal(seen['repo-abc/a.sol'], 'contract A {}\n')
    assert.equal(seen['repo-abc/empty.md'], '')
    assert.equal(seen[long], 'pax long\n')
    assert.equal(seen[longGnu], 'gnu long\n')
    assert.equal(seen[longPrefix], 'prefix long\n')
    assert.equal(seen['repo-abc/z.txt'], 'x'.repeat(513))
    assert.equal(seen['repo-abc/big.bin'], undefined, 'unwanted body skipped')
    assert.equal(types['repo-abc/link'], undefined, 'links never reach want()')
    assert.equal(seen['repo-abc/link'], undefined)
  }
})

await test('tar: bodies over maxBody are not buffered; corrupt and truncated archives fail', async () => {
  const tar = writeTar([{ path: 'r/x.sol', body: 'y'.repeat(5000) }, { path: 'r/ok.sol', body: 'ok' }])
  const got: string[] = []
  await readTar([tar], { want: () => true, file: (e) => void got.push(e.path) }, 4096)
  assert.deepEqual(got, ['r/ok.sol'])
  const bad = Buffer.from(tar)
  bad[10] ^= 0xff // name byte → checksum mismatch
  await assert.rejects(readTar([bad], { want: () => true, file: () => undefined }), TarError)
  await assert.rejects(readTar([tar.subarray(0, 700)], { want: () => true, file: () => undefined }), /truncated/)
})

await test('tar: hard links, devices and FIFOs are skipped (bodies included); absurd sizes are refused', async () => {
  const tar = writeTar([
    { path: 'r/hard.sol', type: 'link', linkPath: 'r/ok.sol', body: 'contract Smuggled {}\n'.repeat(40) },
    { path: 'r/tty', type: 'char' },
    { path: 'r/pipe', type: 'fifo' },
    { path: 'r/ok.sol', body: 'contract Ok {}\n' },
  ])
  const wanted: string[] = []
  const got: Record<string, string> = {}
  await readTar(chunked(tar, 5), {
    want: (e) => {
      wanted.push(e.path)
      return true
    },
    file: (e, b) => void (got[e.path] = b.toString()),
  })
  assert.deepEqual(wanted, ['r/ok.sol'])
  assert.deepEqual(got, { 'r/ok.sol': 'contract Ok {}\n' })
  // base-256 size far beyond any source file
  const huge = patchFirstHeader(writeTar([{ path: 'r/a.sol', body: 'x' }]), (h) => {
    h.fill(0, 124, 136)
    h[124] = 0x80
    h[128] = 0x7f // ≈ 2^63 bytes
  })
  await assert.rejects(readTar([huge], { want: () => true, file: () => undefined }), /size out of range/)
  const negative = patchFirstHeader(writeTar([{ path: 'r/a.sol', body: 'x' }]), (h) => h.fill(0xff, 124, 136))
  await assert.rejects(readTar([negative], { want: () => true, file: () => undefined }), TarError)
})

await test('source: gzip size cap, inflated size cap, ref advertisement parsing', async () => {
  const gz = zlib.gzipSync(writeTar([{ path: 'r/a.sol', body: 'z'.repeat(100_000) + Math.random() }]))
  const ok = inflateArchive(Readable.from([gz]), gz.length + 1, AbortSignal.timeout(5_000))
  const files: string[] = []
  await readTar(ok, { want: () => true, file: (e) => void files.push(e.path) }, 1 << 20)
  assert.deepEqual(files, ['r/a.sol'])
  const tooBig = inflateArchive(Readable.from(chunked(gz)), Math.floor(gz.length / 2), AbortSignal.timeout(5_000))
  await assert.rejects(readTar(tooBig, { want: () => true, file: () => undefined }), ArchiveTooLarge)
  // a gzip bomb: tiny compressed, large inflated
  const bomb = zlib.gzipSync(writeTar([{ path: 'r/zeros.sol', body: Buffer.alloc(4 << 20) }]))
  assert.ok(bomb.length < 64 * 1024)
  const inflated = inflateArchive(Readable.from([bomb]), 1 << 20, AbortSignal.timeout(5_000), 1 << 20)
  await assert.rejects(readTar(inflated, { want: () => false, file: () => undefined }), (e: Error) => e instanceof ArchiveTooLarge && /inflates past/.test(e.message))

  const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s
  const sha1 = 'a'.repeat(40)
  const sha2 = 'b'.repeat(40)
  const adv = Buffer.from(
    pkt('# service=git-upload-pack\n') + '0000' + pkt(`${sha1} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=x\n`) + pkt(`${sha2} refs/heads/dev\n`) + pkt(`${sha1} refs/heads/main\n`),
  )
  assert.equal(findRefInAdvertisement(adv, 'main').sha, sha1)
  assert.equal(findRefInAdvertisement(adv, 'dev').sha, sha2)
  assert.equal(findRefInAdvertisement(adv.subarray(0, 40), 'dev').complete, false)
  // tags (an allowlist ref may be a tag, e.g. gmx-synthetics v2.1): past heads and pulls
  const sha3 = 'c'.repeat(40)
  const sha4 = 'd'.repeat(40)
  const sha5 = 'e'.repeat(40)
  const tags = Buffer.from(
    pkt(`${sha1} HEAD\0symref=HEAD:refs/heads/main\n`) +
      pkt(`${sha1} refs/heads/main\n`) +
      pkt(`${sha2} refs/pull/1/head\n`) +
      pkt(`${sha3} refs/tags/v1.0\n`) + // annotated: tag object, then the peeled commit
      pkt(`${sha4} refs/tags/v1.0^{}\n`) +
      pkt(`${sha5} refs/tags/v2.1\n`) + // lightweight
      pkt(`${sha2} refs/tags/v2.1-rc1\n`) +
      pkt(`${sha3} refs/tags/v3\n`) +
      '0000',
  )
  assert.equal(findRefInAdvertisement(tags, 'v1.0').sha, sha4)
  assert.equal(findRefInAdvertisement(tags, 'v2.1').sha, sha5)
  const last = findRefInAdvertisement(tags, 'v3') // the last ref: complete only at the end of the stream
  assert.equal(last.sha, sha3)
  assert.equal(findRefInAdvertisement(tags, 'v9').sha, null)
  assert.equal(findRefInAdvertisement(tags, 'main').sha, sha1)
  // a pinned 40-hex commit resolves to itself, without the network
  const pin = '0123456789abcdef0123456789abcdef01234567'
  assert.equal(await githubSource.head('owner/name', pin, AbortSignal.abort()), pin)
})

// ─── licenses / filters ─────────────────────────────────────────────────────

await test('licenses: display tiers of SPDX expressions (nothing is excluded)', () => {
  const cases: [string, string][] = [
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['MIT OR Apache-2.0', 'permissive'],
    ['(MIT OR GPL-3.0-or-later)', 'permissive'],
    ['MIT AND GPL-3.0', 'copyleft'],
    ['GPL-2.0-or-later', 'copyleft'],
    ['AGPL-3.0-only', 'copyleft'],
    ['agpl-3.0', 'copyleft'],
    ['LGPL-3.0', 'copyleft'],
    ['MPL-2.0', 'copyleft'],
    ['GPL-3.0+', 'copyleft'],
    ['GPL-2.0-only WITH Classpath-exception-2.0', 'copyleft'],
    ['BUSL-1.1', 'source-available'],
    ['BUSL-1.1 OR GPL-2.0-or-later', 'copyleft'],
    ['(Apache-2.0 OR MIT) AND BUSL-1.1', 'source-available'],
    ['UNLICENSED', 'unknown'],
    ['SSPL-1.0', 'source-available'],
    ['PolyForm-Noncommercial-1.0.0', 'source-available'],
    ['LicenseRef-Metaplex-NFT-1.0', 'source-available'],
    ['LicenseRef-Proprietary', 'source-available'],
    ['LicenseRef-Whatever', 'unknown'],
    ['NOASSERTION', 'unknown'],
    ['none', 'unknown'],
    ['MIT OR', 'unknown'],
    ['', 'unknown'],
  ]
  for (const [e, want] of cases) assert.equal(exprTier(e), want, e)
  assert.equal(canonicalExpr('agpl-3.0'), 'AGPL-3.0')
  assert.equal(canonicalExpr('(mit or apache-2.0)'), '(MIT OR Apache-2.0)')
  assert.equal(canonicalExpr('GPL-3.0-OR-LATER'), 'GPL-3.0-or-later')
  assert.equal(canonicalExpr('LicenseRef-Foo'), 'LicenseRef-Foo')
})

await test('licenses: SPDX headers, license texts, directory combination, repository resolution', () => {
  assert.equal(spdxHeader('// SPDX-License-Identifier: BUSL-1.1\npragma'), 'BUSL-1.1')
  assert.equal(spdxHeader('/* SPDX-License-Identifier: MIT */\nfn x(){}'), 'MIT')
  assert.equal(spdxHeader('# SPDX-License-Identifier: Apache-2.0 OR MIT\n'), 'Apache-2.0 OR MIT')
  assert.equal(spdxHeader('// SPDX-License-Identifier: agpl-3.0\n'), 'AGPL-3.0')
  assert.equal(spdxHeader('contract X {}'), null)
  // common spellings normalised; pointers and placeholders defer to the directory / repository license
  assert.equal(spdxHeader('// SPDX-License-Identifier: Apache 2\n'), 'Apache-2.0')
  assert.equal(spdxHeader('// SPDX-License-Identifier: Apache 2.0\n'), 'Apache-2.0')
  assert.equal(spdxHeader('// SPDX-License-Identifier: Apache License, Version 2.0\n'), 'Apache-2.0')
  assert.equal(spdxHeader('// SPDX-License-Identifier: Apache-2.0.\n'), 'Apache-2.0')
  assert.equal(spdxHeader('// SPDX-License-Identifier: MIT.\n'), 'MIT')
  assert.equal(spdxHeader('// SPDX-License-Identifier: SEE LICENSE IN LICENSE\n'), null)
  assert.equal(spdxHeader('// SPDX-License-Identifier: None\n'), null)
  assert.equal(spdxHeader('// SPDX-License-Identifier: NOASSERTION\n'), null)
  assert.equal(spdxHeader('// SPDX-License-Identifier: \n'), null)
  assert.equal(exprTier(spdxHeader('// SPDX-License-Identifier: BSD-4-Clause\n')!), 'permissive')
  assert.equal(spdxHeader('// SPDX-License-Identifier: bsd-4-clause\n'), 'BSD-4-Clause')
  assert.equal(exprTier(spdxHeader('// SPDX-License-Identifier: LicenseRef-Gyro-1.0\n')!), 'source-available')
  assert.equal(exprTier('UNLICENSED'), 'unknown')
  assert.deepEqual(detectLicenseText(MIT_TEXT), ['MIT'])
  assert.deepEqual(detectLicenseText(APACHE_TEXT), ['Apache-2.0'])
  assert.deepEqual(detectLicenseText(BUSL_TEXT), ['BUSL-1.1'])
  assert.deepEqual(detectLicenseText(GPL3_TEXT), ['GPL-3.0'])
  assert.deepEqual(detectLicenseText(AGPL_NOTICE), ['AGPL-3.0'])
  assert.deepEqual(detectLicenseText(LGPL3_TEXT), ['LGPL-3.0'], 'LGPL text mentions the GPL without being GPL')
  assert.deepEqual(detectLicenseText('MIT OR Apache-2.0\n').sort(), ['Apache-2.0', 'MIT'])
  assert.equal(detectLicenseExpr('MIT OR Apache-2.0\n'), 'MIT OR Apache-2.0')
  assert.equal(detectLicenseExpr('BUSL-1.1\n'), 'BUSL-1.1', 'short pointer files of any tier')
  assert.equal(detectLicenseExpr('Depends on the file, see SPDX-License-Identifier.\n'), null, 'solmate-style pointer')
  // the GPL-3.0 text names the Affero and Lesser licenses in mixed case: still only GPL-3.0
  assert.deepEqual(detectLicenseText(GPL3_TEXT + '\n13. Use with the GNU Affero General Public License.\n ... use the GNU Lesser General Public License instead of this License.'), ['GPL-3.0'])
  // wrapped lines (forge-std style) and ISC (btcd)
  assert.deepEqual(detectLicenseText('Permission is hereby granted, free of charge, to any\nperson obtaining a copy of this software'), ['MIT'])
  assert.deepEqual(
    detectLicenseText('ISC License\n\nPermission to use, copy, modify, and distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.'),
    ['ISC'],
  )
  // project licenses and "all rights reserved"
  assert.deepEqual(detectLicenseText('                     METAPLEX(TM) NFT OPEN SOURCE LICENSE\n\n   Version 1.0, Oct. 2022'), ['LicenseRef-Metaplex-NFT-1.0'])
  assert.deepEqual(detectLicenseText('... is licensed pursuant to the Orca License set forth herein.\n\n  Orca License\n'), ['LicenseRef-Orca'])
  assert.deepEqual(detectLicenseText('Innovation-Enabling Source Code License\n\nCopyright Aptos Foundation'), ['LicenseRef-Aptos-Innovation-Enabling'])
  assert.deepEqual(detectLicenseText('(c) Curve.Fi, 2020 — no license, right of reproduction or distribution is granted'), ['LicenseRef-All-Rights-Reserved'])
  assert.deepEqual(detectLicenseText('Copyright Medium Rare Foundation. 2021. All rights reserved.\n'), ['LicenseRef-All-Rights-Reserved'])
  assert.deepEqual(detectLicenseText('Copyright (c) 2020 X. All rights reserved.\n\n' + MIT_TEXT), ['MIT'], 'a copyright line above an open license')
  assert.equal(exprTier('LicenseRef-All-Rights-Reserved'), 'source-available')
  for (const n of ['LICENSE', 'LICENSE.md', 'license.txt', 'LICENSE-MIT', 'LICENSE-APACHE', 'COPYING', 'COPYING.LESSER', 'UNLICENSE', 'LICENCE', 'LICENSE-BUSL']) assert.equal(isLicenseFile(n), true, n)
  for (const n of ['license.rs', 'license_info.cpp', 'license.yml', 'license-tree.png', 'licenses.json', 'LicenseManager.sol']) assert.equal(isLicenseFile(n), false, n)
  assert.ok(isReadme('README.md') && isReadme('readme') && !isReadme('README-old.md'))

  assert.equal(combineLicenseFiles([]), null)
  assert.equal(combineLicenseFiles([{ name: 'LICENSE', expr: null }]), 'NOASSERTION')
  assert.equal(combineLicenseFiles([{ name: 'LICENSE', expr: 'MIT' }]), 'MIT')
  assert.equal(
    combineLicenseFiles([
      { name: 'LICENSE-APACHE', expr: 'Apache-2.0' },
      { name: 'LICENSE-MIT', expr: 'MIT' },
    ]),
    'Apache-2.0 OR MIT',
    'dual-license files are a choice',
  )
  assert.equal(
    combineLicenseFiles([
      { name: 'COPYING', expr: 'GPL-3.0' },
      { name: 'COPYING.LESSER', expr: 'LGPL-3.0' },
    ]),
    'GPL-3.0 AND LGPL-3.0',
  )
  assert.equal(licenseMatches('GPL-2.0-or-later', ['GPL-2.0']), true)
  assert.equal(licenseMatches('MIT OR Apache-2.0', ['Apache-2.0']), true)
  assert.equal(licenseMatches('MIT', ['BUSL-1.1']), false)

  const lic = (expr: string | null, name = 'LICENSE') => ({ name, expr })
  assert.deepEqual(resolveRepoLicense('MIT', [lic('MIT')]), { license: 'MIT' })
  assert.deepEqual(resolveRepoLicense('MIT', [lic('MIT AND LGPL-3.0')]), { license: 'MIT' }, 'MIT with an LGPL portion elsewhere')
  assert.deepEqual(resolveRepoLicense('BUSL-1.1', [lic('BUSL-1.1')]), { license: 'BUSL-1.1' })
  assert.deepEqual(resolveRepoLicense('NOASSERTION', [lic('BUSL-1.1')]), { license: 'BUSL-1.1' })
  assert.deepEqual(resolveRepoLicense('NOASSERTION', []), { license: 'none' })
  assert.deepEqual(resolveRepoLicense('', [lic(null)]), { license: 'NOASSERTION' })
  assert.deepEqual(resolveRepoLicense('AGPL-3.0-only', [lic(null)]), { license: 'AGPL-3.0-only' }, 'unrecognised LICENSE: the allowlist entry stands')
  assert.deepEqual(resolveRepoLicense('MIT', []), { license: 'MIT' })
  const moved = resolveRepoLicense('MIT', [lic('BUSL-1.1')])
  assert.equal(moved.license, 'BUSL-1.1')
  assert.match(moved.note ?? '', /LICENSE file reads BUSL-1\.1; allowlist lists MIT/)
})

await test('licenses: explicit machine-learning prohibitions are found; ordinary mentions are not', () => {
  const yes = [
    'The Software may not be used to train artificial intelligence or machine learning models.',
    'This code shall not be used for the purpose of training any AI system.',
    'Use of this repository for AI training is prohibited.',
    'Licensee is not permitted to train large language models on the Licensed Work.',
    'No AI training. No scraping.',
    'The contents must not be included in training data sets.',
  ]
  for (const t of yes) assert.ok(forbidsMachineLearning(t), t)
  const no = [
    MIT_TEXT,
    BUSL_TEXT,
    'This oracle uses machine learning to price assets. Training data is published weekly.',
    'Run the training script to tune the gas model.',
    'You may not use the Licensed Work for a Production Use.',
    'Tests must not be used as documentation of the API.',
  ]
  for (const t of no) assert.equal(forbidsMachineLearning(t), null, t)
})

await test('filters: includePaths, skipped dirs, languages, generated / long-line files, license dirs', () => {
  const spec = { includePaths: ['contracts/', 'pkg/*/src'] }
  assert.equal(pathInScope('contracts/Pool.sol', spec), true)
  assert.equal(pathInScope('contracts/lib/Math.sol', spec), false, 'vendored lib/ inside include')
  assert.equal(pathInScope('pkg/vault/src/Vault.sol', spec), true, 'wildcard segment')
  assert.equal(pathInScope('pkg/vault/test/Vault.t.sol', spec), false)
  assert.equal(pathInScope('src/Other.sol', spec), false)
  assert.equal(pathInScope('lib/forge-std/src/Test.sol', {}), false)
  assert.equal(pathInScope('node_modules/@oz/contracts/ERC20.sol', {}), false)
  assert.equal(pathInScope('out/Foo.sol/Foo.json', {}), false)
  assert.equal(pathInScope('lib/core/src/x.rs', { includePaths: ['lib/core'] }), true, 'an include that names lib/ wins')
  assert.equal(pathInScope('contracts/mocks/M.sol', { includePaths: ['contracts'], excludePaths: ['contracts/mocks'] }), false)
  const evm = { ecosystem: 'evm' as const }
  assert.equal(langOf('src/A.sol', evm), 'solidity')
  assert.equal(langOf('contracts/Vault.vy', evm), 'vyper')
  assert.equal(langOf('x/bank/keeper.go', evm), null)
  assert.equal(langOf('x/bank/keeper.go', { ecosystem: 'cosmos' }), 'go')
  assert.equal(langOf('x/bank/types/tx.pb.go', { ecosystem: 'cosmos' }), null)
  assert.equal(langOf('src/script/interpreter.cpp', { ecosystem: 'bitcoin' }), 'cpp')
  assert.equal(langOf('src/script/interpreter.cpp', evm), null)
  assert.equal(langOf('specs/phase0/beacon-chain.py', { ecosystem: 'infra' }), null)
  assert.equal(langOf('specs/phase0/x.py', { ecosystem: 'infra', langs: ['python'] }), 'python')
  assert.equal(langOf('sdk/src/client.ts', { ecosystem: 'solana' }), 'typescript')
  assert.equal(langOf('tests/swap.ts', { ecosystem: 'solana' }), 'typescript')
  assert.equal(langOf('scripts/deploy.ts', evm), null)
  assert.equal(langOf('sdk/index.d.ts', evm), null)
  assert.equal(langOf('idl/whirlpool.json', { ecosystem: 'solana' }), 'idl')
  assert.equal(langOf('package.json', evm), null)
  assert.equal(langOf('package-lock.json', evm), null)
  assert.equal(langOf('Cargo.lock', { ecosystem: 'solana' }), null)
  assert.equal(langOf('CHANGELOG.md', evm), null)
  assert.equal(langOf('docs/guide.md', evm), 'markdown')
  assert.equal(langOf('LICENSE.md', evm), null)
  assert.equal(contentReject('// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x', 'go'), 'generated')
  assert.equal(contentReject('// This file was automatically generated\n', 'rust'), 'generated')
  assert.equal(contentReject(`bytes constant code = hex"${'60'.repeat(4000)}";`, 'solidity'), 'long-line')
  assert.equal(contentReject('{"version":"0.1.0","name":"x"}', 'idl'), 'not-idl')
  assert.equal(contentReject('contract A {}', 'solidity'), null)
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62, 0x0d])), 'a\nb\n')
  assert.equal(decodeText(Buffer.from([0x61, 0x00, 0x62])), null)
  assert.equal(decodeText(Buffer.from([0xc3, 0x28])), null, 'invalid utf-8')

  assert.equal(licenseDirInScope('', {}), true)
  assert.equal(licenseDirInScope('contracts/busl', {}), true)
  assert.equal(licenseDirInScope('node_modules/x', {}), false)
  assert.equal(licenseDirInScope('lib/forge-std', {}), false)
  assert.equal(licenseDirInScope('contracts', { includePaths: ['contracts/core'] }), true, 'above an include path')
  assert.equal(licenseDirInScope('contracts/core/math', { includePaths: ['contracts/core'] }), true)
  assert.equal(licenseDirInScope('scripts', { includePaths: ['contracts/core'] }), false)
  assert.equal(licenseDirInScope('contracts/mocks', { includePaths: ['contracts'], excludePaths: ['contracts/mocks'] }), false)
})

// ─── one archive ────────────────────────────────────────────────────────────

const spec = (repo: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({
  repo,
  ecosystem: 'evm',
  category: 'dex',
  ref: 'main',
  license: 'MIT',
  tier: 'permissive',
  ...extra,
})

async function collect(shards: string[]): Promise<CodeRecord[]> {
  const out: CodeRecord[] = []
  for (const f of shards) for await (const r of readShard(f)) out.push(r)
  return out
}

await test('ingest: paths outside the archive root, traversal, odd segments and backslashes are ignored', async () => {
  const tmpDir = freshDir()
  const tar = writeTar([
    { path: 'r-1/ok.sol', body: sol('Ok', 'MIT') },
    { path: 'r-1/../evil.sol', body: sol('Evil1', 'MIT') },
    { path: 'r-1/a/../../evil2.sol', body: sol('Evil2', 'MIT') },
    { path: 'r-1/a/./b.sol', body: sol('Dot', 'MIT') },
    { path: 'r-1//double.sol', body: sol('Double', 'MIT') },
    { path: 'r-1/back\\slash.sol', body: sol('Back', 'MIT') },
    { path: 'other/x.sol', body: sol('Other', 'MIT') },
    { path: '/abs.sol', body: sol('Abs', 'MIT') },
  ])
  const out = await indexArchive(chunked(tar, 3), { spec: spec('o/r'), commit: 'c'.repeat(40), seen: new Set(), tmpDir, base: 'o__r.1', capBytes: 1 << 30, otherBytes: 0 })
  const recs = await collect(out.shards)
  assert.deepEqual(
    recs.map((r) => r.path),
    ['ok.sol'],
  )
  assert.equal(out.forbidden, null)
})

await test('ingest: a root LICENSE that arrives after the sources relabels the files written before it', async () => {
  const tmpDir = freshDir()
  const tar = writeTar([
    { path: 'g-1/src/A.sol', body: sol('A', null) },
    { path: 'g-1/src/B.sol', body: sol('B', 'GPL-2.0-or-later') },
    { path: 'g-1/src/vendor2/LICENSE', body: MIT_TEXT },
    { path: 'g-1/src/vendor2/C.sol', body: sol('C', null) },
    { path: 'g-1/LICENSE', body: APACHE_TEXT },
  ])
  const out = await indexArchive(chunked(tar, 9), {
    spec: spec('o/g', { license: 'NOASSERTION', tier: 'unknown' }),
    commit: null,
    seen: new Set(),
    tmpDir,
    base: 'o__g.1',
    capBytes: 1 << 30,
    otherBytes: 0,
  })
  assert.equal(out.license, 'Apache-2.0')
  const by = Object.fromEntries((await collect(out.shards)).map((r) => [r.path, r]))
  assert.equal(by['src/A.sol'].license, 'Apache-2.0')
  assert.equal(by['src/A.sol'].tier, 'permissive')
  assert.equal(by['src/B.sol'].license, 'GPL-2.0-or-later', 'own SPDX header kept')
  assert.equal(by['src/B.sol'].tier, 'copyleft')
  assert.equal(by['src/vendor2/C.sol'].license, 'MIT', 'nearest LICENSE directory')
  assert.deepEqual(out.byTier, { permissive: 2, copyleft: 1 })
  assert.equal(readdirSync(tmpDir).length, out.shards.length, 'first-pass shards removed after the relabel')
})

// ─── the index ──────────────────────────────────────────────────────────────

interface FakeRepo {
  commit: string
  entries: TarWriteEntry[]
}

function makeSource(repos: Record<string, FakeRepo>, calls: { head: string[]; open: string[] }, hooks: { block?: string; tooBig?: string; onOpen?: (repo: string) => unknown } = {}): ArchiveSource {
  return {
    async head(repo) {
      calls.head.push(repo)
      return repos[repo]?.commit ?? null
    },
    async open(repo, ref, signal, max, maxInflated) {
      calls.open.push(repo)
      hooks.onOpen?.(repo)
      const r = repos[repo]
      if (!r) throw new HttpStatusError(404, 'archive')
      if (hooks.block === repo) {
        // never delivers: stop() must abort it
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      const root = `${repo.split('/')[1]}-${ref}`
      const tar = writeTar(
        r.entries.map((e) => ({ ...e, path: `${root}/${e.path}` })),
        { comment: r.commit },
      )
      const gz = zlib.gzipSync(tar)
      return inflateArchive(Readable.from(chunked(gz, gz.length)), hooks.tooBig === repo ? 10 : max, signal, maxInflated)
    },
  }
}

const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const C3 = '3'.repeat(40)

const repoA: FakeRepo = {
  commit: C1,
  entries: [
    { path: 'LICENSE', body: MIT_TEXT },
    { path: 'README.md', body: '# A\n' },
    { path: 'src/Token.sol', body: sol('Token', 'MIT') },
    { path: 'src/Busl.sol', body: sol('Busl', 'BUSL-1.1') },
    { path: 'src/Gpl.sol', body: sol('Gpl', 'GPL-3.0-or-later') },
    { path: 'src/Unlicensed.sol', body: sol('U', 'UNLICENSED') },
    { path: 'src/gen/Typechain.sol', body: '// auto-generated by typechain\n' + sol('T', 'MIT') },
    { path: 'src/' + 'nested/'.repeat(20) + 'DeepVault.sol', body: sol('DeepVault', null) },
    { path: 'src/lib/Vendored.sol', body: sol('Vendored', 'MIT') },
    { path: 'src/Huge.sol', body: sol('Huge', 'MIT', '/*' + 'x '.repeat(110_000) + '*/') },
    { path: 'test/Token.t.sol', body: sol('TokenTest', 'MIT') },
  ],
}
const repoB: FakeRepo = {
  commit: C2,
  entries: [
    { path: 'COPYING', body: MIT_TEXT },
    { path: 'contracts/Token.sol', body: sol('Token', 'MIT') }, // same text as A's → dedupe (after newline normalisation)
    { path: 'contracts/Vault.sol', body: sol('Vault', 'MIT OR Apache-2.0') },
    { path: 'contracts/busl/Pool.sol', body: sol('Pool', null) }, // before its directory LICENSE: relabelled afterwards
    { path: 'contracts/busl/LICENSE', body: BUSL_TEXT },
    { path: 'contracts/gpl/LICENSE', body: GPL3_TEXT },
    { path: 'contracts/gpl/Gov.sol', body: sol('Gov', null) },
    { path: 'node_modules/x/X.sol', body: sol('X', 'MIT') },
    { path: 'node_modules/x/LICENSE', body: GPL3_TEXT },
    { path: 'out/Foo.sol', body: sol('Foo', 'MIT') },
    { path: 'docs/' + 'guide/'.repeat(25) + 'intro.md', body: '# intro\n', longMode: 'gnu' },
    { path: 'scripts/deploy.ts', body: 'export {}\n' },
    { path: 'sdk/client.ts', body: 'export const client = 1\n' },
  ],
}
const repoC: FakeRepo = {
  commit: C3,
  entries: [
    { path: 'LICENSE', body: GPL3_TEXT },
    { path: 'contracts/Pair.sol', body: sol('Pair', 'GPL-3.0') },
  ],
}
const repoD: FakeRepo = { commit: '4'.repeat(40), entries: [{ path: 'LICENSE', body: BUSL_TEXT }, { path: 'src/X.sol', body: sol('Xd', null) }] }
const repoE: FakeRepo = { commit: '5'.repeat(40), entries: [{ path: 'LICENSE', body: MIT_TEXT }, { path: 'src/E.sol', body: sol('E', 'MIT') }] }
const repoF: FakeRepo = {
  commit: '6'.repeat(40),
  entries: [
    { path: 'src/F.sol', body: sol('F', 'MIT') },
    { path: 'src/G.sol', body: sol('G', null) },
  ],
} // no LICENSE file

const SPECS: RepoSpec[] = [
  spec('o/a', { includePaths: ['src'] }),
  spec('o/b', { ecosystem: 'solana', category: 'lending' }),
  spec('o/c', { license: 'GPL-3.0', tier: 'copyleft' }),
  spec('o/d'),
  spec('o/e'),
  spec('o/f', { license: 'NOASSERTION', tier: 'unknown' }),
]
const ALL: Record<string, FakeRepo> = { 'o/a': repoA, 'o/b': repoB, 'o/c': repoC, 'o/d': repoD, 'o/e': repoE, 'o/f': repoF }

async function runUntilIdle(o: Partial<CodeIndexInternals> & { dataDir: string; source: ArchiveSource }, stopEarly?: (logs: string[]) => boolean) {
  const logs: string[] = []
  let idle!: () => void
  const idleP = new Promise<void>((r) => (idle = r))
  const idx = createCodeIndexWith({
    repos: SPECS,
    log: (lvl, msg) => {
      logs.push(`${lvl} ${msg}`)
      if (stopEarly?.(logs)) idle()
    },
    startDelayMs: 0,
    gapMs: 0,
    diskReserveBytes: 0,
    onIdle: () => idle(),
    ...o,
  })
  idx.start()
  await Promise.race([idleP, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout waiting for idle')), 20_000))])
  await idx.stop()
  return { idx, logs, stats: idx.stats() }
}

async function records(dataDir: string): Promise<CodeRecord[]> {
  const dir = join(dataDir, 'code')
  const out: CodeRecord[] = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl.gz')).sort()) for await (const r of readShard(join(dir, f))) out.push(r)
  return out
}

await test('index: every license tier is indexed; per-file and per-repo licenses recorded; filters, dedupe, size limit', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  const { stats } = await runUntilIdle({ dataDir, source: makeSource(ALL, calls, { tooBig: 'o/e' }) })
  const by = Object.fromEntries(stats.repos.map((r) => [r.repo, r]))
  assert.equal(by['o/a'].status, 'ok')
  assert.equal(by['o/a'].commit, C1)
  assert.equal(by['o/a'].license, 'MIT')
  assert.equal(by['o/a'].tier, 'permissive')
  assert.equal(by['o/b'].status, 'ok')
  assert.equal(by['o/c'].status, 'ok', 'GPL repositories are indexed')
  assert.equal(by['o/c'].license, 'GPL-3.0')
  assert.equal(by['o/c'].tier, 'copyleft')
  assert.equal(by['o/d'].status, 'ok', 'BUSL repositories are indexed')
  assert.equal(by['o/d'].license, 'BUSL-1.1', 'the LICENSE file at the commit wins over the allowlist entry')
  assert.equal(by['o/d'].tier, 'source-available')
  assert.match(by['o/d'].note ?? '', /allowlist lists MIT/)
  assert.equal(by['o/e'].status, 'skipped')
  assert.match(by['o/e'].note ?? '', /archive larger than/)
  assert.equal(by['o/f'].status, 'ok', 'repositories without a license file are indexed')
  assert.equal(by['o/f'].license, 'none')
  assert.equal(by['o/f'].tier, 'unknown')
  for (const r of stats.repos) assert.ok(!('copyleftEnabled' in r))
  assert.ok(!('copyleftEnabled' in stats))

  const recs = await records(dataDir)
  const paths = recs.map((r) => `${r.repo}:${r.path}`).sort()
  assert.deepEqual(paths, [
    'o/a:src/Busl.sol',
    'o/a:src/Gpl.sol',
    'o/a:src/Token.sol',
    'o/a:src/Unlicensed.sol',
    'o/a:src/' + 'nested/'.repeat(20) + 'DeepVault.sol',
    'o/b:contracts/Vault.sol',
    'o/b:contracts/busl/Pool.sol',
    'o/b:contracts/gpl/Gov.sol',
    'o/b:docs/' + 'guide/'.repeat(25) + 'intro.md',
    'o/b:sdk/client.ts',
    'o/c:contracts/Pair.sol',
    'o/d:src/X.sol',
    'o/f:src/F.sol',
    'o/f:src/G.sol',
  ])
  const rec = (repo: string, p: string) => recs.find((r) => r.repo === repo && r.path === p)!
  const tok = rec('o/a', 'src/Token.sol')
  assert.equal(tok.text.includes('\r'), false, 'newlines normalised')
  assert.equal(tok.commit, C1)
  assert.equal(tok.license, 'MIT')
  assert.equal(tok.tier, 'permissive')
  assert.equal(tok.lang, 'solidity')
  assert.equal(tok.ecosystem, 'evm')
  assert.equal(tok.bytes, Buffer.byteLength(tok.text))
  assert.match(tok.sha256, /^[0-9a-f]{64}$/)
  const expect: [string, string, string, string][] = [
    ['o/a', 'src/Busl.sol', 'BUSL-1.1', 'source-available'],
    ['o/a', 'src/Gpl.sol', 'GPL-3.0-or-later', 'copyleft'],
    ['o/a', 'src/Unlicensed.sol', 'UNLICENSED', 'unknown'],
    ['o/a', 'src/' + 'nested/'.repeat(20) + 'DeepVault.sol', 'MIT', 'permissive'],
    ['o/b', 'contracts/Vault.sol', 'MIT OR Apache-2.0', 'permissive'],
    ['o/b', 'contracts/busl/Pool.sol', 'BUSL-1.1', 'source-available'],
    ['o/b', 'contracts/gpl/Gov.sol', 'GPL-3.0', 'copyleft'],
    ['o/b', 'sdk/client.ts', 'MIT', 'permissive'],
    ['o/c', 'contracts/Pair.sol', 'GPL-3.0', 'copyleft'],
    ['o/d', 'src/X.sol', 'BUSL-1.1', 'source-available'],
    ['o/f', 'src/F.sol', 'MIT', 'permissive'],
    ['o/f', 'src/G.sol', 'none', 'unknown'],
  ]
  for (const [repo, p, license, tier] of expect) {
    assert.equal(rec(repo, p).license, license, `${repo}:${p} license`)
    assert.equal(rec(repo, p).tier, tier, `${repo}:${p} tier`)
  }
  const vault = rec('o/b', 'contracts/Vault.sol')
  assert.equal(vault.ecosystem, 'solana')
  assert.equal(vault.category, 'lending')
  assert.equal(by['o/a'].files, 5)
  assert.equal(by['o/b'].files, 5)
  assert.equal(stats.files, 14)
  assert.equal(stats.bytes, recs.reduce((a, r) => a + r.bytes, 0))
  assert.equal(stats.byEcosystem.evm, by['o/a'].bytes + by['o/c'].bytes + by['o/d'].bytes + by['o/f'].bytes)
  assert.equal(stats.byEcosystem.solana, by['o/b'].bytes)
  assert.ok(stats.byLang.solidity > 0 && stats.byLang.markdown > 0 && stats.byLang.typescript > 0)
  assert.ok(stats.updatedAt !== null)
  assert.deepEqual(readdirSync(join(dataDir, 'code', 'tmp')), [], 'temp dir empty')
})

await test('index: skipped only when not found / not public or a LICENSE / README forbids machine-learning use', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  const repos: Record<string, FakeRepo> = {
    'o/ml1': {
      commit: 'a'.repeat(40),
      entries: [
        { path: 'LICENSE', body: MIT_TEXT + '\n\nThe Software may not be used to train artificial intelligence or machine learning models.\n' },
        { path: 'src/A.sol', body: sol('Ml1', 'MIT') },
      ],
    },
    'o/ml2': {
      commit: 'b'.repeat(40),
      entries: [
        { path: 'LICENSE', body: MIT_TEXT },
        { path: 'README.md', body: '# Protocol\n\nUse of this repository for AI training is prohibited.\n' },
        { path: 'src/B.sol', body: sol('Ml2', 'MIT') },
      ],
    },
    'o/fine': {
      commit: 'c'.repeat(40),
      entries: [
        { path: 'LICENSE', body: BUSL_TEXT },
        { path: 'README.md', body: '# Oracle\n\nThis oracle uses machine learning to price assets. Training data is published weekly.\n' },
        { path: 'src/C.sol', body: sol('Fine', 'BUSL-1.1') },
      ],
    },
  }
  const specs = [spec('o/ml1'), spec('o/ml2', { includePaths: ['src'] }), spec('o/gone'), spec('o/fine', { license: 'BUSL-1.1', tier: 'source-available' })]
  let t = Date.now()
  const { stats } = await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: specs, now: () => t })
  const by = Object.fromEntries(stats.repos.map((r) => [r.repo, r]))
  assert.equal(by['o/ml1'].status, 'skipped')
  assert.match(by['o/ml1'].note ?? '', /^LICENSE forbids machine-learning use: "may not be used to train/)
  assert.equal(by['o/ml2'].status, 'skipped', 'root README checked even outside includePaths')
  assert.match(by['o/ml2'].note ?? '', /^README\.md forbids machine-learning use/)
  assert.equal(by['o/gone'].status, 'skipped')
  assert.equal(by['o/gone'].note, 'not found or not public (HTTP 404)')
  assert.equal(by['o/fine'].status, 'ok')
  assert.equal(by['o/fine'].license, 'BUSL-1.1')
  assert.equal(by['o/fine'].files, 2, 'source + README')
  const recs = await records(dataDir)
  assert.deepEqual(recs.map((r) => `${r.repo}:${r.path}`).sort(), ['o/fine:README.md', 'o/fine:src/C.sol'])
  assert.equal(recs.find((r) => r.path === 'README.md')!.license, 'BUSL-1.1')

  // a 404 is retried after a day, not a week
  calls.open.length = 0
  t += 25 * 3_600_000
  await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: specs, now: () => t })
  assert.deepEqual(calls.open, ['o/gone'])
})

await test('index: compressed size cap stops adding and marks the repos left out (note "cap")', async () => {
  const dataDir = freshDir()
  const noise = (n: number, seed: number) => {
    let s = seed
    let out = ''
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
      out += String.fromCharCode(97 + (s % 26))
      if (i % 80 === 79) out += '\n// '
    }
    return out
  }
  const fat = (name: string, seed: number): FakeRepo => ({
    commit: String(seed).repeat(40).slice(0, 40),
    entries: [{ path: 'LICENSE', body: MIT_TEXT }, ...Array.from({ length: 6 }, (_, i) => ({ path: `src/F${i}.sol`, body: sol(`${name}${i}`, 'MIT', `// ${noise(20_000, seed * 10 + i)}`) }))],
  })
  const repos = { 'o/a': fat('A', 1), 'o/b': fat('B', 2), 'o/c': fat('C', 3), 'o/d': fat('D', 4) }
  const calls = { head: [] as string[], open: [] as string[] }
  const { stats } = await runUntilIdle({
    dataDir,
    source: makeSource(repos, calls),
    repos: [spec('o/a'), spec('o/b'), spec('o/c'), spec('o/d')],
    maxMb: 0.1, // ~105 KB compressed; each repo is ~75 KB
    maxShardBytes: 30_000,
  })
  const by = Object.fromEntries(stats.repos.map((r) => [r.repo, r]))
  assert.equal(by['o/a'].status, 'ok', JSON.stringify(by['o/a']))
  assert.equal(by['o/a'].files, 6)
  assert.equal(by['o/b'].status, 'ok')
  assert.equal(by['o/b'].note, 'partial (cap)', JSON.stringify(stats.repos.map((r) => [r.repo, r.status, r.files, r.note])))
  assert.ok(by['o/b'].files < 6)
  for (const r of ['o/c', 'o/d']) {
    assert.equal(by[r].status, 'skipped')
    assert.equal(by[r].note, 'cap')
  }
  let gz = 0
  for (const f of readdirSync(join(dataDir, 'code')).filter((n) => n.endsWith('.gz'))) gz += statSync(join(dataDir, 'code', f)).size
  assert.ok(gz <= 0.1 * 1048576 + 48 * 1024, `compressed total ${gz} within the cap (+gzip lag)`)
  assert.ok(readdirSync(join(dataDir, 'code')).filter((n) => /^o__a\.\d+\.\d+\.jsonl\.gz$/.test(n)).length >= 2, 'shards roll over')

  // a lowered cap on restart drops whole repositories from the end of the allowlist
  calls.open.length = 0
  const r2 = await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: [spec('o/a'), spec('o/b'), spec('o/c'), spec('o/d')], maxMb: 0.08, maxShardBytes: 30_000 })
  const by2 = Object.fromEntries(r2.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by2['o/a'].status, 'ok')
  assert.equal(by2['o/b'].status, 'skipped')
  assert.equal(by2['o/b'].note, 'cap')
  assert.deepEqual(calls.open, [], 'nothing downloaded while the cap is full')
})

await test('index: resume after restart (done repos kept, interrupted one refetched, junk removed); refresh only when the commit or the entry moves', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  const specs = [spec('o/a', { includePaths: ['src'] }), spec('o/b', { ecosystem: 'solana' })]
  // run 1: o/b never finishes downloading; stop mid-repo
  const r1 = await runUntilIdle({ dataDir, source: makeSource(ALL, calls, { block: 'o/b' }), repos: specs }, (logs) => logs.some((l) => l.includes('o/a@')))
  assert.equal(r1.stats.repos[0].status, 'ok')
  assert.equal(r1.stats.repos[1].status, 'pending')
  // leftovers of a crash: temp shard + an orphan shard index.json does not reference
  writeFileSync(join(dataDir, 'code', 'tmp', 'o__b.9.0.jsonl.gz'), 'partial')
  writeFileSync(join(dataDir, 'code', 'o__b.7.0.jsonl.gz'), 'orphan')

  calls.head.length = 0
  calls.open.length = 0
  let t = Date.now()
  const r2 = await runUntilIdle({ dataDir, source: makeSource(ALL, calls), repos: specs, now: () => t })
  assert.deepEqual(calls.open, ['o/b'], 'only the unfinished repo is downloaded')
  assert.equal(r2.stats.repos[1].status, 'ok')
  assert.ok(!existsSync(join(dataDir, 'code', 'o__b.7.0.jsonl.gz')), 'orphan removed')
  assert.ok(!existsSync(join(dataDir, 'code', 'tmp', 'o__b.9.0.jsonl.gz')), 'temp removed')
  const fetchedA = r2.stats.repos[0].fetchedAt!

  // 8 days later, same commits: heads are checked, nothing is downloaded, fetchedAt moves
  t += 8 * 86_400_000
  calls.head.length = 0
  calls.open.length = 0
  const r3 = await runUntilIdle({ dataDir, source: makeSource(ALL, calls), repos: specs, now: () => t })
  assert.deepEqual(calls.head.sort(), ['o/a', 'o/b'])
  assert.deepEqual(calls.open, [])
  assert.ok(r3.stats.repos[0].fetchedAt! > fetchedA)

  // a new commit on o/a after another 8 days: re-downloaded and replaced, the old shards removed
  t += 8 * 86_400_000
  const moved = { ...ALL, 'o/a': { ...repoA, commit: '9'.repeat(40), entries: [...repoA.entries, { path: 'src/New.sol', body: sol('New', 'MIT') }] } }
  calls.open.length = 0
  const r4 = await runUntilIdle({ dataDir, source: makeSource(moved, calls), repos: specs, now: () => t })
  assert.deepEqual(calls.open, ['o/a'])
  assert.equal(r4.stats.repos[0].commit, '9'.repeat(40))
  assert.equal(r4.stats.repos[0].files, 6)
  let recs = await records(dataDir)
  assert.equal(recs.filter((r) => r.repo === 'o/a').length, 6, 'old generation removed')
  assert.ok(recs.filter((r) => r.repo === 'o/a').every((r) => r.commit === '9'.repeat(40)))

  // within 7 days nothing is due at all
  calls.head.length = 0
  await runUntilIdle({ dataDir, source: makeSource(moved, calls), repos: specs, now: () => t + 86_400_000 })
  assert.deepEqual(calls.head, [])

  // ... unless the allowlist entry changes: same commit, wider includePaths → re-indexed now
  calls.open.length = 0
  const wider = [spec('o/a', { includePaths: ['src', 'test'] }), specs[1]]
  const r5 = await runUntilIdle({ dataDir, source: makeSource(moved, calls), repos: wider, now: () => t + 86_400_000 })
  assert.deepEqual(calls.open, ['o/a'])
  assert.equal(r5.stats.repos[0].files, 7)
  recs = await records(dataDir)
  assert.ok(recs.some((r) => r.path === 'test/Token.t.sol'))
})

await test('index: an upstream relicense is recorded, not excluded; a later ML prohibition drops the data; network errors keep it', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  const specs = [spec('o/e')]
  let t = Date.now()
  await runUntilIdle({ dataDir, source: makeSource(ALL, calls), repos: specs, now: () => t })
  // network failure on refresh: still ok, data kept
  t += 8 * 86_400_000
  const broken: ArchiveSource = { head: async () => '7'.repeat(40), open: async () => Promise.reject(new Error('socket hang up')) }
  const r2 = await runUntilIdle({ dataDir, source: broken, repos: specs, now: () => t })
  assert.equal(r2.stats.repos[0].status, 'ok')
  assert.equal(r2.stats.repos[0].files, 1)
  // relicensed to BUSL upstream: still indexed, the new license recorded
  t += 86_400_000
  const relicensed = {
    'o/e': {
      commit: '8'.repeat(40),
      entries: [
        { path: 'LICENSE', body: BUSL_TEXT },
        { path: 'src/E.sol', body: sol('E', 'MIT') },
        { path: 'src/E2.sol', body: sol('E2', null) },
      ],
    },
  }
  const r3 = await runUntilIdle({ dataDir, source: makeSource(relicensed, calls), repos: specs, now: () => t })
  assert.equal(r3.stats.repos[0].status, 'ok')
  assert.equal(r3.stats.repos[0].license, 'BUSL-1.1')
  assert.equal(r3.stats.repos[0].tier, 'source-available')
  assert.equal(r3.stats.files, 2)
  const recs = await records(dataDir)
  assert.equal(recs.find((r) => r.path === 'src/E.sol')!.license, 'MIT')
  assert.equal(recs.find((r) => r.path === 'src/E2.sol')!.license, 'BUSL-1.1')
  // the README now forbids AI training: skipped, its data removed
  t += 8 * 86_400_000
  const banned = { 'o/e': { commit: '9'.repeat(40), entries: [...relicensed['o/e'].entries, { path: 'README.md', body: 'This code shall not be used for the purpose of training any AI system.' }] } }
  const r4 = await runUntilIdle({ dataDir, source: makeSource(banned, calls), repos: specs, now: () => t })
  assert.equal(r4.stats.repos[0].status, 'skipped')
  assert.equal(r4.stats.files, 0)
  assert.equal((await records(dataDir)).length, 0)
})

// ─── robustness: cap, refresh, failures, state file ─────────────────────────

/** Incompressible-ish text (base64 of a seeded byte stream) in 76-char comment lines. */
function rnd(n: number, seed: number): string {
  let s = seed >>> 0 || 1
  const bytes = Buffer.alloc(Math.ceil((n * 3) / 4))
  for (let i = 0; i < bytes.length; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    bytes[i] = s & 0xff
  }
  return bytes
    .toString('base64')
    .slice(0, n)
    .replace(/(.{76})/g, '$1\n// ')
}

const fatRepo = (name: string, commit: string, files: number, seed: number): FakeRepo => ({
  commit,
  entries: [{ path: 'LICENSE', body: MIT_TEXT }, ...Array.from({ length: files }, (_, i) => ({ path: `src/${name}${i}.sol`, body: sol(`${name}${i}`, 'MIT', `\n// ${rnd(6_000, seed * 1000 + i)}`) }))],
})

function unreferenced(dataDir: string): string[] {
  const dir = join(dataDir, 'code')
  const st = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { repos: Record<string, { shards: string[]; shaFile: string | null }> }
  const keep = new Set<string>()
  for (const r of Object.values(st.repos)) {
    for (const s of r.shards) keep.add(s)
    if (r.shaFile) keep.add(r.shaFile)
  }
  return readdirSync(dir).filter((f) => f !== 'tmp' && !f.startsWith('index.json') && !keep.has(f))
}

function codeGz(dataDir: string): number {
  let n = 0
  for (const f of readdirSync(join(dataDir, 'code')).filter((x) => x.endsWith('.gz'))) n += statSync(join(dataDir, 'code', f)).size
  return n
}

await test('ingest: files over 200 KB are dropped unless the entry names them in largeFiles (kept up to 640 KB)', async () => {
  const tmpDir = freshDir()
  const big = sol('Big', 'MIT', '\n' + '// line of core validation logic\n'.repeat(9_500))
  const huge = sol('Huge', 'MIT', '\n' + '// x\n'.repeat(140_000))
  assert.ok(big.length > MAX_FILE_BYTES && big.length < LARGE_FILE_BYTES, String(big.length))
  assert.ok(huge.length > LARGE_FILE_BYTES)
  const tar = writeTar([
    { path: 'v-1/src/validation.sol', body: big },
    { path: 'v-1/src/other.sol', body: big.replace('Big', 'Other') },
    { path: 'v-1/src/huge.sol', body: huge },
  ])
  const s = spec('o/v', { largeFiles: ['src/validation.sol', 'src/huge.sol'] })
  assert.equal(fileLimit('src/validation.sol', s), LARGE_FILE_BYTES)
  assert.equal(fileLimit('src/other.sol', s), MAX_FILE_BYTES)
  assert.equal(fileLimit('src/validation.sol', spec('o/w')), MAX_FILE_BYTES)
  const out = await indexArchive(chunked(tar, 5), { spec: s, commit: 'c'.repeat(40), seen: new Set(), tmpDir, base: 'o__v.1', capBytes: 1 << 30, otherBytes: 0 })
  const recs = await collect(out.shards)
  assert.deepEqual(
    recs.map((r) => r.path),
    ['src/validation.sol'],
  )
  assert.ok(recs[0].bytes > MAX_FILE_BYTES)
  assert.equal(out.skipped['too-large'], 2)
})

await test('index: a repository that stopped at the cap is kept on restart under the same cap (gzip tail tolerated)', async () => {
  const dataDir = freshDir()
  const repos = { 'o/a': fatRepo('A', C1, 40, 1), 'o/b': fatRepo('B', C2, 40, 2) }
  const specs = [spec('o/a'), spec('o/b')]
  const calls = { head: [] as string[], open: [] as string[] }
  const t = Date.now()
  const r1 = await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: specs, maxMb: 0.3, now: () => t })
  const by1 = Object.fromEntries(r1.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by1['o/a'].status, 'ok')
  assert.equal(by1['o/b'].note, 'partial (cap)', JSON.stringify(r1.stats.repos.map((r) => [r.repo, r.status, r.note])))
  assert.ok(codeGz(dataDir) <= 0.3 * 1048576 + 64 * 1024, `total ${codeGz(dataDir)}`)
  calls.open.length = 0
  const r2 = await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: specs, maxMb: 0.3, now: () => t + 60_000 })
  assert.ok(!r2.logs.some((l) => /size cap lowered|over the .* size cap/.test(l)), r2.logs.join('\n'))
  const by2 = Object.fromEntries(r2.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by2['o/b'].status, 'ok')
  assert.equal(by2['o/b'].files, by1['o/b'].files)
  assert.deepEqual(calls.open, [], 'nothing downloaded again')
})

await test('index: an indexed repository keeps its space at refresh when the cap is full; a partial copy is finished once the cap is raised', async () => {
  const dataDir = freshDir()
  const repos: Record<string, FakeRepo> = { 'o/hi': repoE, 'o/lo': fatRepo('L', C2, 60, 9) }
  const specs = [spec('o/hi'), spec('o/lo')]
  const calls = { head: [] as string[], open: [] as string[] }
  let t = Date.now()
  await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: specs, maxMb: 100, now: () => t })
  const total = codeGz(dataDir)
  // the index is now exactly full: a cap just above what it holds
  const fullMb = (total + 1) / 1048576
  t += 8 * 86_400_000
  calls.open.length = 0
  const r2 = await runUntilIdle({ dataDir, source: makeSource(repos, calls), repos: specs, maxMb: fullMb, now: () => t })
  const by2 = Object.fromEntries(r2.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by2['o/hi'].status, 'ok', 'the top-priority repository is not dropped at its refresh')
  assert.equal(by2['o/hi'].files, 1)
  assert.equal(by2['o/lo'].status, 'ok')
  assert.deepEqual(calls.open, [], 'unchanged heads: nothing downloaded')
  // a new commit of the top repository that no longer fits: the copy of the old commit stays
  t += 8 * 86_400_000
  const grown = { ...repos, 'o/hi': { commit: '7'.repeat(40), entries: [...repoE.entries, { path: 'src/Big.sol', body: sol('Big', 'MIT', `\n// ${rnd(40_000, 77)}`) }] } }
  const r3 = await runUntilIdle({ dataDir, source: makeSource(grown, calls), repos: specs, maxMb: fullMb, now: () => t })
  const by3 = Object.fromEntries(r3.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by3['o/hi'].status, 'ok')
  assert.equal(by3['o/hi'].commit, repoE.commit)
  assert.equal(by3['o/hi'].files, 1)
  assert.ok(r3.logs.some((l) => l.includes('does not fit under the size cap')))

  // partial copy at a small cap, then the cap is raised with no upstream change: completed
  const d2 = freshDir()
  const lo = { 'o/lo': fatRepo('L', C2, 60, 9) }
  let t2 = Date.now()
  const p1 = await runUntilIdle({ dataDir: d2, source: makeSource(lo, calls), repos: [spec('o/lo')], maxMb: 0.2, now: () => t2 })
  assert.equal(p1.stats.repos[0].note, 'partial (cap)')
  assert.ok(p1.stats.repos[0].files < 60)
  t2 += 8 * 86_400_000
  calls.open.length = 0
  const p2 = await runUntilIdle({ dataDir: d2, source: makeSource(lo, calls), repos: [spec('o/lo')], maxMb: 100, now: () => t2 })
  assert.deepEqual(calls.open, ['o/lo'])
  assert.equal(p2.stats.repos[0].files, 60)
  assert.equal(p2.stats.repos[0].note, undefined)
  // and the next week it is plain unchanged
  t2 += 8 * 86_400_000
  calls.open.length = 0
  await runUntilIdle({ dataDir: d2, source: makeSource(lo, calls), repos: [spec('o/lo')], maxMb: 100, now: () => t2 })
  assert.deepEqual(calls.open, [])
})

await test('index: a failed commit leaves no orphan shards and keeps the old copy and its dedupe keys', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  let t = Date.now()
  await runUntilIdle({ dataDir, source: makeSource(ALL, calls), repos: [spec('o/a', { includePaths: ['src'] })], now: () => t })
  t += 8 * 86_400_000
  const moved = { ...ALL, 'o/a': { ...repoA, commit: '9'.repeat(40), entries: [...repoA.entries, { path: 'src/New.sol', body: sol('New', 'MIT') }] }, 'o/dup': { commit: '8'.repeat(40), entries: [{ path: 'src/Token.sol', body: sol('Token', 'MIT') }, { path: 'src/Own.sol', body: sol('Own', 'MIT') }] } }
  // the dedupe file of o/a's next generation cannot be written (a directory is in the way)
  const hooks = { onOpen: (repo: string) => repo === 'o/a' && mkdirSync(join(dataDir, 'code', 'tmp', 'o__a.2.sha'), { recursive: true }) }
  const r2 = await runUntilIdle({ dataDir, source: makeSource(moved, calls, hooks), repos: [spec('o/a', { includePaths: ['src'] }), spec('o/dup')], now: () => t })
  const by = Object.fromEntries(r2.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by['o/a'].status, 'ok', 'old copy kept')
  assert.equal(by['o/a'].commit, C1)
  assert.equal(by['o/a'].files, 5)
  assert.ok(r2.logs.some((l) => /o\/a: EISDIR/.test(l)), r2.logs.join('\n'))
  assert.deepEqual(unreferenced(dataDir), [], 'no orphan shards')
  const recs = await records(dataDir)
  assert.deepEqual(recs.filter((r) => r.repo === 'o/dup').map((r) => r.path), ['src/Own.sol'], "o/a's keys still dedupe")
  assert.equal(recs.filter((r) => r.repo === 'o/a').length, 5)
})

await test('index: a 404 for a listed repository keeps its data (retried); 404 on both endpoints or for a day drops it', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  let t = Date.now()
  const specs = [spec('o/e'), spec('o/c', { license: 'GPL-3.0', tier: 'copyleft' })]
  await runUntilIdle({ dataDir, source: makeSource(ALL, calls), repos: specs, now: () => t })
  const flaky: ArchiveSource = {
    head: async (repo) => (repo === 'o/c' ? Promise.reject(new HttpStatusError(401, 'refs')) : '7'.repeat(40)),
    open: async () => Promise.reject(new HttpStatusError(404, 'archive')),
  }
  t += 8 * 86_400_000
  const r2 = await runUntilIdle({ dataDir, source: flaky, repos: specs, now: () => t })
  const by2 = Object.fromEntries(r2.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by2['o/e'].status, 'ok', 'a codeload 404 alone keeps the data')
  assert.equal(by2['o/e'].files, 1)
  assert.equal(by2['o/c'].status, 'skipped', 'no ref advertisement either: gone')
  assert.equal(by2['o/c'].note, 'not found or not public (HTTP 404)')
  t += 25 * 3_600_000
  const r3 = await runUntilIdle({ dataDir, source: flaky, repos: specs, now: () => t })
  const by3 = Object.fromEntries(r3.stats.repos.map((r) => [r.repo, r]))
  assert.equal(by3['o/e'].status, 'skipped', 'still 404 after a day')
  assert.equal(by3['o/e'].files, 0)
  assert.deepEqual(unreferenced(dataDir), [])
})

await test('index: GitHub rate limits pause every download (Retry-After honoured); no archive fallback; public notes are short', async () => {
  const dataDir = freshDir()
  let heads = 0
  let opens = 0
  const limited: ArchiveSource = {
    head: async () => {
      heads++
      throw new HttpStatusError(429, 'refs', 10 * 60_000)
    },
    open: async () => {
      opens++
      throw new Error('not reached')
    },
  }
  const specs = [spec('o/a'), spec('o/b'), spec('o/c'), spec('o/d')]
  let t = Date.now()
  const r1 = await runUntilIdle({ dataDir, source: limited, repos: specs, now: () => t })
  assert.equal(heads, 1, 'one request, then everything waits')
  assert.equal(opens, 0, 'a refused ref lookup is not turned into an archive download')
  assert.ok(r1.logs.some((l) => l.includes('all downloads paused for 10 min')), r1.logs.join('\n'))
  assert.equal(r1.stats.repos[0].status, 'error')
  assert.equal(r1.stats.repos[0].note, 'HTTP 429')
  assert.equal(r1.stats.repos[1].note, 'waiting for GitHub')
  // after the pause, a working source indexes the rest
  t += 11 * 60_000
  const calls = { head: [] as string[], open: [] as string[] }
  const r2 = await runUntilIdle({ dataDir, source: makeSource({ 'o/b': repoB, 'o/c': repoC, 'o/d': repoD }, calls), repos: specs, now: () => t })
  assert.deepEqual(r2.stats.repos.slice(1).map((r) => r.status), ['ok', 'ok', 'ok'])

  assert.equal(publicNote(new HttpStatusError(503, 'archive')), 'HTTP 503')
  assert.equal(publicNote(new TypeError('fetch failed')), 'network error')
  assert.equal(publicNote(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), 'network error')
  assert.equal(publicNote(Object.assign(new Error("EMFILE: too many open files, open '/var/data/lusca/code/tmp/x.1.0.jsonl.gz'"), { code: 'EMFILE', syscall: 'open' })), 'storage error')
  assert.equal(publicNote(Object.assign(new Error('incorrect header check'), { code: 'Z_DATA_ERROR' })), 'archive unreadable')
  assert.equal(publicNote(new TarError('bad octal field')), 'archive unreadable')
  assert.equal(publicNote(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'timed out')
  assert.ok(isTransient(new HttpStatusError(429, 'refs')) && isTransient(new HttpStatusError(502, 'archive')) && isTransient(new HttpStatusError(403, 'archive')))
  assert.ok(!isTransient(new HttpStatusError(404, 'archive')) && !isTransient(new Error('EISDIR')))
  assert.equal(parseRetryAfter('120'), 120_000)
  assert.equal(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString(), Date.now()) !== undefined, true)
  assert.equal(parseRetryAfter(null), undefined)
  assert.equal(parseRetryAfter('soon'), undefined)
})

await test('index: an unreadable index.json pauses the index without touching disk; a corrupt one rebuilds and keeps old shards until replaced', async () => {
  const dataDir = freshDir()
  const calls = { head: [] as string[], open: [] as string[] }
  const specs = [spec('o/a', { includePaths: ['src'] }), spec('o/b', { ecosystem: 'solana' })]
  let t = Date.now()
  await runUntilIdle({ dataDir, source: makeSource(ALL, calls), repos: specs, now: () => t })
  const dir = join(dataDir, 'code')
  const before = readdirSync(dir).filter((f) => f.endsWith('.gz')).sort()
  assert.ok(before.length >= 2)

  // a read error that is not ENOENT (here EISDIR): nothing removed, nothing fetched, nothing written
  const good = readFileSync(join(dir, 'index.json'))
  rmSync(join(dir, 'index.json'))
  mkdirSync(join(dir, 'index.json'))
  calls.open.length = 0
  const logs: string[] = []
  const idx = createCodeIndexWith({ dataDir, repos: specs, source: makeSource(ALL, calls), log: (l, m) => logs.push(`${l} ${m}`), startDelayMs: 0, gapMs: 0, diskReserveBytes: 0, now: () => t })
  idx.start()
  await new Promise((r) => setTimeout(r, 200))
  await idx.stop()
  assert.ok(logs.some((l) => l.includes('paused until the next restart')), logs.join('\n'))
  assert.deepEqual(calls.open, [])
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.gz')).sort(), before, 'shards untouched')
  assert.ok(statSync(join(dir, 'index.json')).isDirectory(), 'index.json not overwritten')
  rmSync(join(dir, 'index.json'), { recursive: true })

  // corrupt JSON: rebuilt; o/a re-indexed (its old shards replaced), o/b interrupted (its old shards still there)
  writeFileSync(join(dir, 'index.json'), good.subarray(0, 40))
  writeFileSync(join(dir, 'index.json.corrupt-1'), 'old')
  writeFileSync(join(dir, 'index.json.corrupt-2'), 'old')
  t += 60_000
  const r = await runUntilIdle({ dataDir, source: makeSource(ALL, calls, { block: 'o/b' }), repos: specs, now: () => t }, (l) => l.some((x) => x.includes('o/a@')))
  assert.equal(r.stats.repos[0].status, 'ok')
  const oldA = before.filter((f) => f.startsWith('o__a.'))
  const oldB = before.filter((f) => f.startsWith('o__b.'))
  const now2 = readdirSync(dir)
  for (const f of oldB) assert.ok(now2.includes(f), `${f} kept until o/b is indexed again`)
  const st = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { repos: Record<string, { shards: string[] }> }
  for (const f of oldA) assert.ok(!now2.includes(f) || st.repos['o/a'].shards.includes(f), `${f} replaced`)
  assert.equal(now2.filter((f) => f.startsWith('index.json.corrupt-')).length, 1, 'only the newest moved-aside copy kept')
})

await test('allowlist: well-formed, unique, no memecoin / token-clone repos, tiers consistent with licenses', () => {
  if (!REPOS.length) {
    console.log('     (allowlist empty — entries are checked once repos.ts is filled)')
    return
  }
  assert.ok(REPOS.length <= 200, `${REPOS.length} repositories`)
  const names = new Set<string>()
  const ecos = new Set(['evm', 'solana', 'move', 'cairo', 'cosmos', 'bitcoin', 'infra'])
  const cats = new Set(['dex', 'lending', 'stablecoin', 'staking', 'bridge-rollup', 'account-abstraction', 'wallet', 'token-standard', 'oracle', 'governance', 'client-vm', 'framework', 'security'])
  const tiers = new Set(['permissive', 'copyleft', 'source-available', 'unknown'])
  for (const r of REPOS) {
    assert.match(r.repo, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
    assert.ok(!names.has(r.repo.toLowerCase()), `duplicate ${r.repo}`)
    names.add(r.repo.toLowerCase())
    assert.ok(ecos.has(r.ecosystem), `${r.repo} ecosystem`)
    assert.ok(cats.has(r.category), `${r.repo} category`)
    assert.match(r.ref, /^[A-Za-z0-9._/-]+$/, `${r.repo} ref`)
    assert.equal(typeof r.license, 'string', `${r.repo} license`)
    assert.ok(tiers.has(r.tier), `${r.repo} tier ${r.tier}`)
    const t = exprTier(r.license)
    // a recognised license must carry its tier; an unrecognised one may be classified by hand
    if (t !== 'unknown') assert.equal(r.tier, t, `${r.repo}: ${r.license} is ${t}, entry says ${r.tier}`)
    assert.ok(!/pump|meme|moon|inu\b|doge|shib|pepe|bonk/i.test(r.repo), `${r.repo} looks like a memecoin`)
    for (const f of r.largeFiles ?? []) {
      assert.ok(pathInScope(f, r), `${r.repo}: largeFiles ${f} is outside includePaths`)
      assert.ok(langOf(f, r), `${r.repo}: largeFiles ${f} is not a kept file type`)
    }
  }
})

rmSync(tmp, { recursive: true, force: true })
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
