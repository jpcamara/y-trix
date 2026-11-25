// Property test for simpleDiff: always correct, never larger than the unhinted diff,
// and an insertion ending at the caret is placed at the caret. Run: node tests/diff.unit.mjs
import { simpleDiff, textDiff, seqDiff } from '../src/text-diff.js'
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

// Surrogate pairs: no edit may remove or insert half of one, for either diff.
const CHARS = ['a', 'b', ' ', '\u{1F600}', '\u{1F601}', '\u{1F469}', '\u{1F9D1}', '\u200d']
const estr = (n) => Array.from({ length: n }, () => CHARS[rand(CHARS.length)]).join('')
const isHigh = (c) => c >= '\ud800' && c <= '\udbff'
const isLow = (c) => c >= '\udc00' && c <= '\udfff'
const whole = (s) => { for (let i = 0; i < s.length; i++) { if (isHigh(s[i])) { if (!isLow(s[i + 1] || '')) return false; i++ } else if (isLow(s[i])) return false } return true }
let split = 0
for (let i = 0; i < 200000; i++) {
  const a = estr(rand(7)); const b = rand(4) === 0 ? estr(rand(7)) : (() => { const cs = Array.from(a); const at = rand(cs.length + 1); cs.splice(at, rand(Math.min(2, cs.length - at) + 1), ...Array.from(estr(rand(3)))); return cs.join('') })()
  const cursor = rand(3) === 0 ? undefined : rand(b.length + 1)
  for (const ops of [[simpleDiff(a, b, cursor)], textDiff(a, b, cursor)]) {
    let out = a
    for (const op of ops.slice().reverse()) out = out.slice(0, op.index) + op.insert + out.slice(op.index + op.remove)
    const ok = out === b && ops.every((op, k) => whole(op.insert) && whole(a.slice(op.index, op.index + op.remove)) && (k === 0 || ops[k - 1].index + ops[k - 1].remove <= op.index))
    if (!ok) { split++; if (split < 4) console.log('split pair', JSON.stringify({ a, b, cursor, ops })) }
  }
}
console.log('surrogate pair failures:', split)
bad += split

// seqDiff: applying its edits gives b, and it is minimal enough that two far
// apart edits in a long text stay two small edits.
let seq = 0
for (let i = 0; i < 20000; i++) {
  const a = str(rand(30)); const b = rand(3) === 0 ? str(rand(30)) : a.slice(0, rand(a.length + 1)) + str(rand(3)) + a.slice(rand(a.length + 1))
  const ops = seqDiff(a, b, 1000)
  let out = a
  for (const op of ops.slice().reverse()) out = out.slice(0, op.index) + b.slice(op.at, op.at + op.insert) + out.slice(op.index + op.remove)
  if (out !== b) { seq++; if (seq < 4) console.log('seqDiff wrong', JSON.stringify({ a, b, ops })) }
}
{
  const long = Array.from({ length: 3000 }, (_, i) => 'word' + (i % 97)).join(' ')
  const edited = long.slice(0, 100) + 'X' + long.slice(100, 9000) + 'YY' + long.slice(9003)
  const ops = textDiff(long, edited)
  const changed = ops.reduce((n, op) => n + op.remove + op.insert.length, 0)
  let out = long
  for (const op of ops.slice().reverse()) out = out.slice(0, op.index) + op.insert + out.slice(op.index + op.remove)
  if (out !== edited || changed > 10) { seq++; console.log('far apart edits were not kept small', ops.length, changed) }
}
console.log('seqDiff failures:', seq)
bad += seq
console.log('simpleDiff property failures:', bad)
if (bad) process.exit(1)

// textDiff: applying the edits right to left reproduces b, and a space turned
// into a no-break space next to the edit stays a separate small change.
// textDiff is imported above
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
