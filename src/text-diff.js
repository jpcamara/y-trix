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
  if (x.length * y.length > 4096) {
    // Too big for the table below. Two edits far apart must still not turn
    // into deleting and re-inserting everything between them: someone else
    // doing the same at that moment would leave that text there twice.
    const far = seqDiff(x, y, 1500)
    if (far === null) return [d]
    return far.map((op) => wholeChars(a, { index: d.index + op.index, remove: op.remove, insert: y.slice(op.at, op.at + op.insert) }))
  }
  const w = y.length + 1
  const lcs = new Uint16Array((x.length + 1) * w)
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
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
    if (i < x.length && j < y.length && x[i] === y[j] && lcs[i * w + j] === lcs[(i + 1) * w + j + 1] + 1) {
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
