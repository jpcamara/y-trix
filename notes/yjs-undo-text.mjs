// Pure Yjs (no Trix) fuzz of the binding's data model: two docs sharing one
// Y.Text, concurrent inserts, deletes, formats and block-break inserts, each
// side with its own Y.UndoManager. Checks whether the Yjs undo bugs seen with
// nested XML types (yjs/yjs#823 divergence, yjs/yjs#809 throw) can be reached
// with a single flat Y.Text.
// Run: node notes/yjs-undo-text.mjs [runs]   (UNDO=0 leaves undo out)
import * as Y from 'yjs'
let bad = 0; let errs = 0
const N = Number(process.argv[2] || 20000)
const UNDO = process.env.UNDO !== '0'
for (let seed = 1; seed <= N; seed++) {
  let s = seed
  const rand = (n) => { s = (s * 16807) % 2147483647; return s % n }
  const docs = [new Y.Doc(), new Y.Doc()]; docs[0].clientID = 1; docs[1].clientID = 2
  const queues = [[], []]
  docs.forEach((d, i) => d.on('update', (u, o) => { if (o !== 'remote') queues[1 - i].push(u) }))
  const texts = docs.map((d) => d.getText('trix'))
  docs[0].transact(() => { texts[0].insert(0, 'Hello'); texts[0].insert(5, '\n', { blockBreak: true }); texts[0].insert(6, 'Second'); texts[0].insert(12, '\n', { blockBreak: true }) })
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]), 'remote'); queues[1].length = 0
  const ums = docs.map((d, i) => new Y.UndoManager(texts[i], { trackedOrigins: new Set(['local']), captureTimeout: 1e9 }))
  try {
    for (let k = 0; k < 80; k++) {
      const i = rand(2); const t = texts[i]
      const op = rand(10)
      if (op === 0) { if (UNDO) ums[i].undo() } else if (op === 1) { if (UNDO) ums[i].redo() }
      else if (op === 2 && rand(2)) ums[i].stopCapturing()
      else if (op === 3 && t.length > 0) docs[i].transact(() => { const at = rand(t.length); t.delete(at, Math.min(1 + rand(3), t.length - at)) }, 'local')
      else if (op === 4) docs[i].transact(() => t.insert(rand(t.length + 1), '\n', { blockBreak: true, block: rand(2) ? ['quote'] : null }), 'local')
      else if (op === 5 && t.length > 0) docs[i].transact(() => { const at = rand(t.length); t.format(at, Math.min(1 + rand(4), t.length - at), { bold: rand(2) ? true : null }) }, 'local')
      else if (op === 6 && t.length > 0) docs[i].transact(() => t.format(rand(t.length), 1, { block: [['heading1'], ['bulletList', 'bullet'], null][rand(3)] }), 'local')
      else docs[i].transact(() => t.insert(rand(t.length + 1), ['x', 'yy', 'zz z'][rand(3)], { bold: null, blockBreak: null, block: null }), 'local')
      const j = rand(2)
      while (queues[j].length && rand(2)) Y.applyUpdate(docs[j], queues[j].shift(), 'remote')
    }
  } catch (e) { errs++; if (errs < 3) console.log('seed', seed, 'threw', e.message); continue }
  // Applying an update can make Yjs clean up formatting, which is a new update: drain to a fixpoint
  while (queues[0].length || queues[1].length) for (const j of [0, 1]) while (queues[j].length) Y.applyUpdate(docs[j], queues[j].shift(), 'remote')
  // toDelta can split equal runs differently on each side; compare per character
  const chars = (t) => JSON.stringify(t.toDelta().flatMap((op) => [...op.insert].map((c) => [c, JSON.stringify(op.attributes || {})])))
  const a = chars(texts[0]); const b = chars(texts[1])
  if (a !== b) { bad++; if (bad < 3) console.log('seed', seed, a, b) }
}
console.log('diverged:', bad, 'threw:', errs, '/', N)
