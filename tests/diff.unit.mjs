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

// A change in very many places (a word replaced all through a long document)
// is edits in those places: never one edit over everything from the first to
// the last, which would take out what others are typing in between.
let bad3 = 0
s = 17
const apply = (a, ops) => { let out = a; for (const op of ops.slice().reverse()) out = out.slice(0, op.index) + op.insert + out.slice(op.index + op.remove); return out }
{
  let a = ''
  for (let i = 0; i < 1500; i++) a += `Paragraph ${i} has a cat and a cat in it \u{1F600}.\n`
  const b = a.replace(/cat/g, 'dog')
  const ops = textDiff(a, b)
  if (apply(a, ops) !== b) { bad3++; console.log('replace all: wrong result') }
  if (ops.length < 1500 || ops.some((op) => op.remove > 40 || op.insert.length > 40)) { bad3++; console.log('replace all: not line by line', ops.length, ops[0]) }
}
{
  // a longer one where the word is in every third line, with lines added and taken out as well
  let a = ''
  for (let i = 0; i < 6000; i++) a += i % 3 === 0 ? `Paragraph ${i} has a cat and a cat in it.\n` : `Paragraph ${i} has none.\n`
  const more = a.replace(/cat/g, 'dog').split('\n'); more.splice(4000, 2); more.splice(100, 0, 'a new line', 'and another'); more.splice(5000, 0, 'at the end')
  const c = more.join('\n')
  const moved = textDiff(a, c)
  if (apply(a, moved) !== c) { bad3++; console.log('replace all with lines moved: wrong result') }
  // (also then: edits in their places, with the lines that came or went)
  if (moved.length < 2000 || moved.some((op) => op.remove > 200 || op.insert.length > 200)) { bad3++; console.log('replace all with lines moved: not in its places', moved.length) }
}
for (let i = 0; i < 300; i++) {
  // long random documents, changed in many lines
  const n = 300 + rand(300)
  const la = Array.from({ length: n }, (_, k) => `line ${k} ${str(rand(12))} \u{1F600}`)
  const lb = la.map((l) => rand(3) ? l.replace(/a/g, 'cc') + str(rand(3)) : l)
  if (rand(2)) lb.splice(rand(lb.length), rand(4))
  if (rand(2)) lb.splice(rand(lb.length), 0, str(5), str(6))
  const a = la.join('\n') + '\n'; const b = lb.join('\n') + '\n'
  const ops = textDiff(a, b, rand(2) ? undefined : rand(b.length + 1))
  if (apply(a, ops) !== b) { bad3++; if (bad3 < 4) console.log('long document: wrong result', i) }
  for (const op of ops) if (!whole(op.insert) || !whole(a.slice(op.index, op.index + op.remove))) { bad3++; if (bad3 < 4) console.log('long document: half an emoji', op) }
}
{
  // a short document replaced by a long one that has nothing to do with it, and back
  const a = 'Hello world. Edit me in either editor.\nSecond paragraph.\n'
  let b = ''
  for (let i = 0; i < 80; i++) b += `Paragraph ${i} lorem ipsum dolor sit amet.\n`
  for (const [from, to] of [[a, b], [b, a], [b + b + b, a + b], ['x'.repeat(5000) + '\n' + 'y'.repeat(5000) + '\n', 'z'.repeat(6000) + '\n' + 'w'.repeat(3000) + '\n']]) {
    if (apply(from, textDiff(from, to)) !== to) { bad3++; console.log('unrelated documents: wrong result') }
  }
}
{
  // lines moving around a short one: its text is kept, not written again
  // (as many line ends can be kept either way)
  const a = 'Xw\n\n\ue000\n\n.\n'
  const b = 'Xw\n\n\n.\n\n\n\ue001\n\ue001\n\ue001\n\ue001\n\ue002\n'
  for (const cursor of [undefined, 18, 4]) {
    const ops = textDiff(a, b, cursor)
    if (apply(a, ops) !== b) { bad3++; console.log('short line: wrong result') }
    if (ops.some((op) => op.insert.includes('.'))) { bad3++; console.log('short line: its text is written again', JSON.stringify(ops)) }
  }
}
{
  // lines and objects put in before the last letter of a line, with more after it:
  // the letter is kept though more line ends could be kept without it
  const E = '\ue000'; const B = '\ue001'
  const a = `e${E}\n${E}\nco\n\nnxd\n\n\n${E}\n\n${B}\n${B}\n${B}\n${B}\n`
  const b = `e${E} ${E}co nx\n\n\n${B}\n${B}\n${B}\n${B}\nd ${E}\n${B}\n${B}\n${B}\n${B}\n`
  const ops = textDiff(a, b, 20)
  if (apply(a, ops) !== b) { bad3++; console.log('lines before a letter: wrong result') }
  if (ops.some((op) => op.insert.includes('d'))) { bad3++; console.log('lines before a letter: the letter is written again', JSON.stringify(ops)) }
}
console.log('textDiff long document failures:', bad3)
if (bad3) process.exit(1)
