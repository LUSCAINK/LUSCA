// PII redaction at ingest (extract.ts redactPII): same output as the original regexes, in linear time.
//   npx tsx server/ingest/_redact_test.ts
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { redactPII } from './extract.ts'

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}\n${(e as Error).stack}`)
    process.exitCode = 1
  }
}

// The reference: what redactPII did before it became linear (quadratic on long runs of letters and digits).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(?<![\w.\/#-])\+?\(?\d{1,4}\)?[ .-]\d{2,4}[ .-]\d{3,4}(?:[ .-]\d{2,4})?(?![\w.\/-])/g
const reference = (s: string) => s.replace(EMAIL_RE, '[email]').replace(PHONE_RE, '[phone]')

test('known cases', () => {
  const cases: [string, string][] = [
    ['mail jane.doe@example.org today', 'mail [email] today'],
    ['a@b.co.uk', '[email]'],
    ['x@y.c', 'x@y.c'],
    ['a@b.com-x', '[email]-x'],
    ['foo@bar.baz.q1', '[email].q1'],
    ['@a.com and a@@b.com', '@a.com and a@@b.com'],
    ['a.b@c.d.ef@g.hi', '[email]@g.hi'],
    ['see a@b.co,c@d.io;', 'see [email],[email];'],
    ['call +1 415 555 0100 now', 'call [phone] now'],
    ['version 0.8.20 and 2024-01-15', 'version 0.8.20 and 2024-01-15'],
    ['@openzeppelin/contracts and @notice', '@openzeppelin/contracts and @notice'],
  ]
  for (const [input, want] of cases) {
    assert.equal(redactPII(input), want, input)
    assert.equal(reference(input), want, `reference: ${input}`)
  }
})

test('fuzz: identical to the original regexes', () => {
  const alphabet = 'ab.@-_+%9Z x@\n.co1 +()'
  let n = 0
  for (let i = 0; i < 200_000; i++) {
    const len = 1 + Math.floor(Math.random() * 32)
    let s = ''
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
    assert.equal(redactPII(s), reference(s), JSON.stringify(s))
    n++
  }
  assert.equal(n, 200_000)
})

test('linear on long runs (hex calldata, bytecode, base64 on a page)', () => {
  const t0 = Date.now()
  const hex = `0x${randomBytes(500_000).toString('hex')}`
  assert.equal(redactPII(hex), hex)
  const run = `${'a'.repeat(400_000)}@${'b'.repeat(400_000)}.cc`
  assert.equal(redactPII(run), '[email]')
  const many = 'x@y.zz '.repeat(100_000)
  assert.equal(redactPII(many), '[email] '.repeat(100_000))
  const ms = Date.now() - t0
  assert.ok(ms < 2000, `took ${ms} ms`) // the original regex needs minutes for the first input alone
})

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`)
