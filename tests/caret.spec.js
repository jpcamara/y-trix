// One user's caret has to stay with its text while the others edit: after
// any edit made elsewhere, the caret is where a Yjs relative position taken
// before the edit says it is. The others edit through Y (every Trix editor
// on a page shares the page's one selection, so only one can hold a caret).
// CARET_SEEDS=1,2,3 CARET_ROUNDS=60 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

for (const seed0 of (process.env.CARET_SEEDS || '1,2,3,4').split(',').map(Number)) {
  test(`trix: a caret stays with its text while others edit (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(120000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    await page.fill('#delay', '5')
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const wrong = []
    let judged = 0
    for (let round = 0; round < Number(process.env.CARET_ROUNDS || 40); round++) {
      const len = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getLength())
      const at = rand(len)
      await caret(page, 0, at).catch(() => {})
      // a selection now and then
      const span = rand(3) === 0 ? 1 + rand(6) : 0
      const had = await page.evaluate(({ at, span }) => {
        const { editor, doc } = window.ytDemo.peers[0]
        const Y = window.ytDemo.Y
        if (span > 0) editor.setSelectedRange([at, Math.min(at + span, editor.getDocument().getLength() - 1)])
        const sel = editor.getSelectedRange()
        const type = doc.getText('trix')
        // (text someone else types exactly at the caret, or at either end of a selection, goes after that point)
        window.caretWas = sel.map((index) => Y.createRelativePositionFromTypeIndex(type, Math.min(index, type.length), -1))
        return sel
      }, { at, span })
      // the others edit, in Y
      const did = await page.evaluate(({ s, n }) => {
        let seed = s
        const rand = (k) => { seed = (seed * 16807) % 2147483647; return seed % k }
        const pick = (a) => a[rand(a.length)]
        const did = []
        for (let i = 0; i < n; i++) {
          const p = window.ytDemo.peers[1 + rand(2)]
          const t = p.doc.getText('trix')
          // (never between the halves of an emoji, and never the document's last break)
          const units = t.toDelta().map((o) => (typeof o.insert === 'string' ? o.insert : '\u0000')).join('')
          const low = (k) => k > 0 && k < units.length && units.charCodeAt(k) >= 0xdc00 && units.charCodeAt(k) <= 0xdfff
          const snap = (k) => (low(k) ? k + 1 : k)
          const pos = snap(rand(t.length))
          const count = (k) => Math.max(0, snap(Math.min(pos + k, t.length - 1)) - pos)
          const op = pick(['type', 'type', 'type', 'enter', 'delete', 'range-delete', 'bold', 'heading', 'quote', 'attachment', 'emoji'])
          did.push(op + '@' + pos)
          p.doc.transact(() => {
            if (op === 'type') t.insert(pos, pick(['x', 'yy', 'zz z']))
            else if (op === 'emoji') t.insert(pos, '\u{1F600}')
            else if (op === 'enter') t.insert(pos, '\n', { blockBreak: true })
            else if (op === 'delete') { if (count(1) > 0) t.delete(pos, count(1)) } else if (op === 'range-delete') { if (count(1) > 0) t.delete(pos, count(2 + rand(20))) } else if (op === 'bold') { if (count(1) > 0) t.format(pos, count(1 + rand(8)), { bold: true }) } else if (op === 'attachment') t.insertEmbed(pos, { attachment: { content: '<b>@m</b>', contentType: 'mention' } })
            else {
              // the block the position is in
              const next = units.indexOf('\n', pos)
              if (next >= 0) t.format(next, 1, { block: op === 'heading' ? ['heading1'] : ['quote'] })
            }
          }, 'a peer')
        }
        return did
      }, { s: 1 + rand(2147483000), n: 1 + rand(3) })
      await page.waitForTimeout(40)
      const now = await page.evaluate(() => {
        const { editor, doc } = window.ytDemo.peers[0]
        const Y = window.ytDemo.Y
        const sel = editor.getSelectedRange()
        const want = window.caretWas.map((rel) => { const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc); return abs === null ? null : abs.index })
        // Held to it while the character before each end is still there. Once
        // someone deletes it, where the caret belongs among what was typed
        // at that spot afterwards is anyone's call.
        const alive = window.caretWas.every((rel) => rel.item === null || !Y.getItem(doc.store, rel.item).deleted)
        const text = doc.getText('trix').toDelta().map((op) => (typeof op.insert === 'string' ? op.insert : '￼')).join('')
        const show = (i) => (i === null || i === undefined ? '' : JSON.stringify(text.slice(Math.max(0, i - 12), i) + '|' + text.slice(i, i + 12)))
        // (there is no place after the last block's break)
        const last = editor.getDocument().getLength() - 1
        return { alive, sel, want: want.map((i) => Math.min(i, last)), around: sel && [show(want[0]), show(sel[0]), show(want[1]), show(sel[1])], focused: document.activeElement === window.ytDemo.peers[0].element }
      })
      if (now.alive && now.focused) judged++
      if (now.alive && (now.sel === null || now.sel[0] !== now.want[0] || now.sel[1] !== now.want[1])) wrong.push({ round, did, had, ...now })
    }
    if (wrong.length > 0) console.log('CARET', wrong.length, JSON.stringify(wrong.slice(0, 5)).slice(0, 4000))
    expect(wrong.length).toBe(0)
    // (and it was a real test: most rounds had a caret to judge)
    expect(judged).toBeGreaterThan(Number(process.env.CARET_ROUNDS || 40) / 2)
    await page.evaluate(() => window.ytDemo.syncAll())
    await converge(page, 3)
    expect(errors).toEqual([])
  })
}

// A caret is one place. Text someone else types exactly there must not come
// out between the caret's two ends: it was drawn as that person's selection
// over the other's new text.
for (const what of ['typing', 'Enter and typing']) {
  test(`trix: ${what} at somebody's caret is not drawn as their selection`, async ({ page }) => {
    await open(page)
    // Bob puts the caret after "Hello" and leaves it there
    await caret(page, 1, 5)
    await page.waitForTimeout(150)
    const ends = () => page.evaluate(() => {
      const [a, b] = window.ytDemo.peers
      const Y = window.ytDemo.Y
      const cursor = a.awareness.getStates().get(b.awareness.clientID).cursor
      const index = (json) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), a.doc).index
      return [index(cursor.anchor), index(cursor.head)]
    })
    expect(await ends()).toEqual([5, 5])
    // Alice types right there
    await caret(page, 0, 5)
    if (what !== 'typing') { await page.keyboard.press('Enter'); await page.keyboard.press('Enter') }
    await page.keyboard.type('Hey ya!')
    await converge(page)
    await page.waitForTimeout(150)
    // Bob's caret is still one place, and stayed before what Alice typed
    expect(await ends()).toEqual([5, 5])
    expect(await page.evaluate(() => document.querySelectorAll('.y-trix-selection').length)).toBe(0)
    expect(await page.evaluate(() => document.querySelectorAll('.y-trix-caret').length)).toBeGreaterThan(0)
  })
}

// Text that arrives without key events (in Firefox as a composition, which
// is how an input method types): while a composition is held the caret is
// not published, so it has to be when the composition is over.
test('trix: the others are shown the caret after text that an input method put in', async ({ page }) => {
  await open(page)
  await caret(page, 0, 5)
  const shown = () => page.evaluate(() => {
    const [a, b] = window.ytDemo.peers
    const Y = window.ytDemo.Y
    const cursor = b.awareness.getStates().get(a.awareness.clientID).cursor
    const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), b.doc)
    return [a.editor.getSelectedRange()[0], at && at.index]
  })
  await page.keyboard.insertText('三')
  await expect.poll(() => shown()).toEqual([6, 6])
  await page.keyboard.insertText('丁七')
  await expect.poll(() => shown()).toEqual([8, 8])
  await converge(page)
})
