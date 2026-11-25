// Property test for simpleDiff: always correct, never larger than the unhinted diff,
// and an insertion ending at the caret is placed at the caret. Run: node tests/diff.unit.mjs
import { simpleDiff } from '../src/text-diff.js'
let s = 3
const rand = (n) => { s = (s * 16807) % 2147483647; return s % n }
const str = (n) => Array.from({ length: n }, () => 'ab'[rand(2)]).join('')
let bad = 0
for (let i = 0; i < 200000; i++) {
  const a = str(rand(8)); const pos = rand(a.length + 1); const del = rand(Math.min(3, a.length - pos) + 1); const ins = str(rand(3))
  const b = a.slice(0, pos) + ins + a.slice(pos + del)
  const cursor = rand(3) === 0 ? undefined : rand(b.length + 1)
  const d = simpleDiff(a, b, cursor)
  const out = a.slice(0, d.index) + d.insert + a.slice(d.index + d.remove)
  const base = simpleDiff(a, b)
  if (out !== b || d.remove + d.insert.length > base.remove + base.insert.length || d.index < 0 || d.remove < 0) { bad++; if (bad < 4) console.log({ a, b, cursor, d }) }
  if (cursor === pos + ins.length && del === 0 && d.remove === 0 && d.index !== pos) { bad++; if (bad < 4) console.log('hint ignored', { a, b, cursor, d }) }
}
console.log('simpleDiff property failures:', bad)
if (bad) process.exit(1)

// textDiff: applying the edits right to left reproduces b, and a space turned
// into a no-break space next to the edit stays a separate small change.
const { textDiff } = await import('../src/text-diff.js')
let bad2 = 0
s = 11
for (let i = 0; i < 100000; i++) {
  const a = Array.from({ length: rand(10) }, () => 'ab \u00a0'[rand(4)]).join('')
  const b = Array.from({ length: rand(10) }, () => 'ab \u00a0'[rand(4)]).join('')
  let out = a
  for (const op of textDiff(a, b, rand(2) ? undefined : rand(b.length + 1)).reverse()) out = out.slice(0, op.index) + op.insert + out.slice(op.index + op.remove)
  if (out !== b) { bad2++; if (bad2 < 4) console.log({ a, b, out }) }
}
const nb = textDiff('Helloa ', 'Helloba\u00a0', 6)
if (JSON.stringify(nb) !== JSON.stringify([{ index: 5, remove: 0, insert: 'b' }, { index: 6, remove: 1, insert: '\u00a0' }])) { bad2++; console.log('nbsp case', nb) }
console.log('textDiff property failures:', bad2)
if (bad2) process.exit(1)
