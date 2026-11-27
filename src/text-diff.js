// Text diffs shared by the editor bindings.

const isHigh = (c) => c >= '\ud800' && c <= '\udbff'
const isLow = (c) => c >= '\udc00' && c <= '\udfff'

/**
 * Widen an edit so it does not start or end inside a surrogate pair of `a`.
 * Most emoji share their first half, so a minimal diff of "😀" to "😁"
 * changes only the second half. Yjs cannot send half a pair: other peers
 * would get U+FFFD. With whole characters removed and `a` and the result
 * both well formed, what is inserted is whole characters too.
 */
const wholeChars = (a, op) => {
  let { index, remove, insert } = op
  if (remove === 0 && insert.length === 0) return op
  if (index > 0 && index < a.length && isHigh(a[index - 1]) && isLow(a[index])) {
    index--; remove++; insert = a[index] + insert
  }
  const end = index + remove
  if (end > 0 && end < a.length && isHigh(a[end - 1]) && isLow(a[end])) {
    remove++; insert += a[end]
  }
  return { index, remove, insert }
}

/**
 * Minimal prefix/suffix diff of two strings. A minimal edit can often sit at
 * several equivalent spots ("a" typed next to another "a"). When the caret
 * offset in `b` is known, the spot ending at the caret is chosen, so the
 * change is recorded where the user made it. The hint never makes the diff
 * larger.
 * @param {string} a
 * @param {string} b
 * @param {number} [cursor] caret offset in b
 */
export const simpleDiff = (a, b, cursor) => {
  const min = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < min && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < min && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  const total = Math.min(min, prefix + suffix) // unchanged characters
  let left = prefix
  if (cursor !== undefined) {
    const lo = Math.max(0, total - suffix)
    const want = cursor - Math.max(0, b.length - a.length)
    left = Math.max(lo, Math.min(prefix, want))
  }
  const right = total - left
  return wholeChars(a, { index: left, remove: a.length - left - right, insert: b.slice(left, b.length - right) })
}

/**
 * Myers' diff of two sequences (strings or arrays, compared with ===).
 * Returns the edits in ascending order as { index, remove, at, insert }:
 * remove `remove` items of `a` at `index` and put `insert` items of `b`
 * starting at `at` there. Returns null if more than `maxD` edits are needed.
 * @param {ArrayLike<any>} a
 * @param {ArrayLike<any>} b
 * @param {number} maxD
 */
export const seqDiff = (a, b, maxD) => {
  const n = a.length
  const m = b.length
  const max = Math.min(maxD, n + m)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
  }
  if (found < 0) return null
  // walk back from the end, collecting single edits
  const edits = [] // [aIndex, bIndex, isInsert]
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const row = trace[d] // v before round d, for k in [-d-1, d+1]
    const at = (k) => row[k + d + 1]
    const k = x - y
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x--; y-- }
    if (x === prevX) edits.push([x, y - 1, true]); else edits.push([x - 1, y, false])
    x = prevX
    y = prevY
  }
  edits.reverse()
  const ops = []
  for (const [ai, bi, isInsert] of edits) {
    const last = ops[ops.length - 1]
    if (last && last.index + last.remove === ai && last.at + last.insert === bi) {
      if (isInsert) last.insert++; else last.remove++
    } else {
      ops.push(isInsert ? { index: ai, remove: 0, at: bi, insert: 1 } : { index: ai, remove: 1, at: bi, insert: 0 })
    }
  }
  return ops
}

/** A string as its lines (each with the newline that ends it), and where each starts. */
const lines = (s) => {
  const text = []
  const start = [0]
  let from = 0
  while (from < s.length) {
    const nl = s.indexOf('\n', from)
    const to = nl < 0 ? s.length : nl + 1
    text.push(s.slice(from, to))
    start.push(to)
    from = to
  }
  return { text, start }
}

/**
 * The edits, in lines, that turn a[a0..a1) into b[b0..b1): as seqDiff gives
 * them, and where that needs more edits than it looks for, between the
 * lines that are there once on each side and in the same order (they stay),
 * each stretch on its own. A stretch with as many lines as before and no
 * line to hold on to is taken line for line.
 */
const lineEdits = (a, b, a0, a1, b0, b1, depth) => {
  if (a0 === a1 && b0 === b1) return []
  if (a0 === a1 || b0 === b1) return [{ index: a0, remove: a1 - a0, at: b0, insert: b1 - b0 }]
  const near = seqDiff(a.slice(a0, a1), b.slice(b0, b1), 1500)
  if (near !== null) return near.map((op) => ({ index: a0 + op.index, remove: op.remove, at: b0 + op.at, insert: op.insert }))
  // lines that are there once on each side
  const count = new Map()
  for (let i = a0; i < a1; i++) { const c = count.get(a[i]); if (c === undefined) count.set(a[i], { a: 1, b: 0, ai: i, bi: -1 }); else c.a++ }
  for (let j = b0; j < b1; j++) { const c = count.get(b[j]); if (c !== undefined) { c.b++; c.bi = j } }
  const once = []
  for (let i = a0; i < a1; i++) { const c = count.get(a[i]); if (c.a === 1 && c.b === 1) once.push(c) }
  // the longest run of them that is in the same order on both sides
  const tails = []
  const prev = new Array(once.length).fill(-1)
  for (let k = 0; k < once.length; k++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (once[tails[mid]].bi < once[k].bi) lo = mid + 1; else hi = mid }
    if (lo > 0) prev[k] = tails[lo - 1]
    tails[lo] = k
  }
  const anchors = []
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) anchors.push(once[k])
  anchors.reverse()
  if (anchors.length === 0 || depth > 40) {
    const out = []
    const n = Math.min(a1 - a0, b1 - b0)
    if (a1 - a0 === b1 - b0) {
      for (let k = 0; k < n; k++) if (a[a0 + k] !== b[b0 + k]) out.push({ index: a0 + k, remove: 1, at: b0 + k, insert: 1 })
      return out
    }
    return [{ index: a0, remove: a1 - a0, at: b0, insert: b1 - b0 }]
  }
  const out = []
  let ai = a0
  let bi = b0
  for (const anchor of anchors) {
    for (const op of lineEdits(a, b, ai, anchor.ai, bi, anchor.bi, depth + 1)) out.push(op)
    ai = anchor.ai + 1
    bi = anchor.bi + 1
  }
  for (const op of lineEdits(a, b, ai, a1, bi, b1, depth + 1)) out.push(op)
  return out
}

/**
 * The edits that turn the lines `was` into the lines `now`, which are in
 * their place: character by character where that is a small matter, and
 * else all of it. (Never by line again: that is where this is called from.)
 */
const withinLines = (was, now) => {
  const all = [{ index: 0, remove: was.length, insert: now }]
  if (was.length === 0 || now.length === 0) return all
  const d = simpleDiff(was, now)
  const x = d.remove
  const y = d.insert.length
  if (x === 0 || y === 0 || x * y <= 4096) return textDiff(was, now)
  const far = seqDiff(was.slice(d.index, d.index + x), d.insert, 300)
  if (far === null) return all
  return far.map((op) => ({ index: d.index + op.index, remove: op.remove, insert: d.insert.slice(op.at, op.at + op.insert) }))
}

/**
 * Diff as a list of non-overlapping edits in ascending order. Starts from
 * simpleDiff and refines a small changed region with an LCS diff, so a
 * browser rewriting " " to "\u00a0" next to the typed character does not
 * turn into deleting and re-inserting a neighbour's text.
 * @return {Array<{index: number, remove: number, insert: string}>}
 */
export const textDiff = (a, b, cursor) => {
  const d = simpleDiff(a, b, cursor)
  const x = a.slice(d.index, d.index + d.remove)
  const y = d.insert
  if (x.length === 0 || y.length === 0) {
    return d.remove === 0 && d.insert.length === 0 ? [] : [d]
  }
  if (x.length * y.length > 1 << 20) {
    // Too big for the table below. Two edits far apart must still not turn
    // into deleting and re-inserting everything between them: someone else
    // doing the same at that moment would leave that text there twice.
    const far = seqDiff(x, y, 1500)
    if (far !== null) return far.map((op) => wholeChars(a, { index: d.index + op.index, remove: op.remove, insert: y.slice(op.at, op.at + op.insert) }))
    // More edits than that looks for: a word replaced all through a long
    // document. Then line by line. Lines that stayed are found first; if
    // too many changed for that too and there are as many as before, each
    // is taken to be the line that was in its place.
    const lx = lines(x)
    const ly = lines(y)
    const pairs = lineEdits(lx.text, ly.text, 0, lx.text.length, 0, ly.text.length, 0)
    const out = []
    for (const op of pairs) {
      const from = lx.start[op.index]
      const was = x.slice(from, lx.start[op.index + op.remove])
      const now = y.slice(ly.start[op.at], ly.start[op.at + op.insert])
      // (the lines themselves, character by character, where that is a small matter)
      const inner = withinLines(was, now)
      for (const e of inner) out.push(wholeChars(a, { index: d.index + from + e.index, remove: e.remove, insert: e.insert }))
    }
    return out
  }
  // (a character of text kept counts for more than a line end kept: where
  // lines move around a short one, as many line ends can be kept by writing
  // its text again as by keeping it, and text written again is there twice
  // if someone else does the same at that moment)
  // (and more than an object kept, for the same reason)
  const worth = (c) => (c === '\n' ? 1 : c >= '\ue000' && c <= '\uf8ff' ? 2 : 16)
  const w = y.length + 1
  const lcs = new Uint16Array((x.length + 1) * w)
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + worth(x[i]) : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const ops = []
  let cur = null
  let i = 0
  let j = 0
  const at = () => {
    if (cur === null) cur = { index: d.index + i, remove: 0, insert: '' }
    return cur
  }
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j] && lcs[i * w + j] === lcs[(i + 1) * w + j + 1] + worth(x[i])) {
      if (cur) { ops.push(cur); cur = null }
      i++; j++
    } else if (j < y.length && (i === x.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      at().insert += y[j]; j++
    } else {
      at().remove++; i++
    }
  }
  if (cur) ops.push(cur)
  return ops.map((op) => wholeChars(a, op))
}
