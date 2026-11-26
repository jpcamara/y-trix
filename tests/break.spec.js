// Writes straight into Y, of shapes Trix would never make: text and breaks
// with any attributes, block lists that make no sense, attachments of every
// kind. Whatever Y holds, every editor has to show the same document, and
// that document has to be what its Y says.
// BREAK_SEEDS=1,2,3 BREAK_ROUNDS=30 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge, quiet } from './helpers.js'

for (const seed0 of (process.env.BREAK_SEEDS || '11,12').split(',').map(Number)) {
  test(`trix: random writes to Y are shown the same by every editor (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(180000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    // STRICT=1: the settle check having to redraw is a failure too
    if (process.env.STRICT) page.on('console', (m) => { if (m.text().includes('did not show what Y holds')) errors.push(m.text()) })
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    await page.fill('#delay', '10')
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    for (let round = 0; round < Number(process.env.BREAK_ROUNDS || 25); round++) {
      await page.evaluate(({ s, n }) => {
        let seed = s
        const rand = (k) => { seed = (seed * 16807) % 2147483647; return seed % k }
        const pick = (a) => a[rand(a.length)]
        const { peers } = window.ytDemo
        const blockLists = [undefined, [], ['heading1'], ['quote'], ['code'], ['bulletList', 'bullet'], ['numberList', 'number'], ['bulletList', 'bullet', 'bulletList', 'bullet'], ['quote', 'heading1'], ['bullet'], ['bulletList'], ['nonsense'], ['quote', 'quote', 'code'], 'heading1', [7, null], ['numberList', 'bullet'], ['attachmentGallery']]
        const text = () => {
          const out = {}
          for (let i = rand(4); i > 0; i--) {
            const k = pick(['bold', 'italic', 'strike', 'href', 'frozen', 'odd', 'blockBreak', 'block', 'html', 'caption', 'presentation'])
            out[k] = k === 'href' ? pick(['https://example.com/1', 'https://example.com/2', 7, 'javascript:alert(1)']) : k === 'block' ? pick(blockLists) : k === 'html' ? pick([{ class: 'x' }, 'no', { id: 'y' }]) : k === 'caption' ? 'cap' : k === 'presentation' ? 'gallery' : pick([true, true, false, 'yes', 1])
            if (out[k] === undefined) delete out[k]
          }
          return out
        }
        const line = () => {
          const out = rand(6) === 0 ? {} : { blockBreak: true }
          const b = pick(blockLists)
          if (b !== undefined) out.block = b
          if (rand(5) === 0) out.html = pick([{ class: 'x' }, { 'data-a': '1' }, 'no', {}])
          if (rand(4) === 0) Object.assign(out, text(), out.blockBreak ? { blockBreak: true } : {})
          return out
        }
        const embeds = [
          { attachment: { content: '<b>@m</b>', contentType: 'mention' } },
          { attachment: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', contentType: 'image/gif', filename: 'a.gif', filesize: 35, width: 1, height: 1 } },
          { attachment: {} }, { attachment: 'no' }, { other: true }, 7, { attachment: { content: '<script>window.pwned = 1</script>', contentType: 'x' } }
        ]
        for (let i = 0; i < n; i++) {
          const p = pick(peers)
          const t = p.doc.getText('trix')
          // not inside an emoji: see the README on surrogate pairs and the Yjs API
          const units = t.toDelta().map((o) => (typeof o.insert === 'string' ? o.insert : '\u0000')).join('')
          const low = (k) => k > 0 && k < units.length && units.charCodeAt(k) >= 0xdc00 && units.charCodeAt(k) <= 0xdfff
          const snap = (k) => (low(k) ? k + 1 : k)
          const at = snap(rand(t.length + 1))
          const span = (from, len) => snap(Math.min(from + len, t.length)) - from
          const op = rand(10)
          try {
            p.doc.transact(() => {
              if (op < 3) t.insert(at, pick(['x', 'yy', 'zed ', '\u{1F600}', ' ']), text())
              else if (op < 5) t.insert(at, '\n', line())
              else if (op === 5) t.insertEmbed(at, pick(embeds), text())
              else if (op === 6) { if (at < t.length) t.delete(at, span(at, 1 + rand(4))) } else if (op === 7) { if (at < t.length) t.format(at, span(at, 1 + rand(6)), rand(2) ? text() : Object.fromEntries(Object.keys(text()).map((k) => [k, null]))) } else if (op === 8) { if (at < t.length) t.format(at, span(at, 1 + rand(3)), line()) } else t.insert(at, 'a\nb', rand(2) ? line() : text())
            }, 'a peer')
          } catch (e) { console.error('write failed', e) }
        }
      }, { s: 1 + rand(2147483000), n: 12 })
      // and someone types in between
      const peer = rand(3)
      const len = await page.evaluate((i) => window.ytDemo.peers[i].editor.getDocument().getLength(), peer)
      await caret(page, peer, rand(len)).catch(() => {})
      const what = rand(4)
      if (what === 0) await page.keyboard.type('Q')
      else if (what === 1) await page.keyboard.press('Enter')
      else if (what === 2) await page.keyboard.press('Backspace')
      await page.waitForTimeout(30)
    }
    await page.evaluate(() => window.ytDemo.syncAll())
    await converge(page, 3, 15000)
    expect(await page.evaluate(() => window.pwned)).toBeUndefined()
    expect(errors).toEqual([])
    await quiet(page)
  })
}

// Trix moves attachments marked as a gallery into a block of their own after
// every render. Done after a remote change, each editor added block breaks
// that Y never heard of, and was two characters longer than Y from then on.
test('trix: gallery attachments left in a text block by a merge keep editor and Y the same length', async ({ page }) => {
  await open(page)
  const lengths = () => page.evaluate(() => window.ytDemo.peers.map((p) => [p.editor.getDocument().getLength(), p.doc.getText('trix').length]))
  await page.evaluate(() => {
    const t = window.ytDemo.peers[1].doc.getText('trix')
    const att = { attachment: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', contentType: 'image/gif', filename: 'a.gif', filesize: 35, width: 1, height: 1 } }
    window.ytDemo.peers[1].doc.transact(() => { t.insert(2, 'ab'); t.insertEmbed(4, att, { presentation: 'gallery' }); t.insertEmbed(5, att, { presentation: 'gallery' }); t.insert(6, 'cd') }, 'a peer')
  })
  await converge(page)
  for (const [editor, y] of await lengths()) expect(editor).toBe(y)
  // the next local edit tidies it, as part of that edit, for everyone
  await page.evaluate(() => { const e = window.ytDemo.peers[0].editor; e.setSelectedRange([0, 0]); e.insertString('Z') })
  await converge(page)
  for (const [editor, y] of await lengths()) expect(editor).toBe(y)
  expect(await page.evaluate(() => window.ytDemo.peers[1].editor.getDocument().getBlocks().some((b) => b.attributes.includes('attachmentGallery')))).toBe(true)
})

// Trix moves a link on an attachment's piece into the attachment and reports
// an edit. Each editor wrote that edit when the link arrived from someone
// else, replacing the embed, so the attachment was there once per editor.
test('trix: a link applied over an attachment by a peer does not duplicate it', async ({ page }) => {
  await open(page)
  await page.evaluate(() => window.ytDemo.addPeer())
  const count = () => page.evaluate(() => window.ytDemo.peers.map((p) => [p.editor.getDocument().getAttachments().length, p.doc.getText('trix').toDelta().filter((op) => typeof op.insert !== 'string').length]))
  await page.evaluate(() => {
    const p = window.ytDemo.peers[1]
    p.doc.transact(() => p.doc.getText('trix').insertEmbed(2, { attachment: { content: '<b>@m</b>', contentType: 'mention' } }, {}), 'a peer')
  })
  await converge(page, 3)
  await page.evaluate(() => { const p = window.ytDemo.peers[1]; p.doc.transact(() => p.doc.getText('trix').format(1, 3, { href: 'https://example.com/2' }), 'a peer') })
  await converge(page, 3)
  expect(await count()).toEqual([[1, 1], [1, 1], [1, 1]])
  await page.evaluate(() => { const p = window.ytDemo.peers[1]; p.doc.transact(() => p.doc.getText('trix').format(1, 3, { href: null }), 'a peer') })
  await converge(page, 3)
  expect(await count()).toEqual([[1, 1], [1, 1], [1, 1]])
  expect(await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getAttachments()[0].getAttributes().href)).toBeUndefined()
})

// Yjs turns an emoji into two U+FFFD when anything is put between its halves,
// even if that thing is gone again by the time the update arrives. The change
// event then says nothing changed, and the editor went on showing the emoji.
test('trix: an emoji split by an edit that was undone before it arrived reads the same everywhere', async ({ page }) => {
  await open(page)
  await caret(page, 0, 5)
  await page.keyboard.insertText('\u{1F680}')
  await converge(page)
  await page.uncheck('#online')
  await page.evaluate(() => { const ed = window.ytDemo.peers[0].editor; ed.setSelectedRange([6, 6]); ed.insertString('x'); ed.setSelectedRange([6, 7]); ed.deleteInDirection('backward') })
  await page.check('#online')
  await page.evaluate(() => window.ytDemo.syncAll())
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => window.ytDemo.peers.map((p) => [p.doc.getText('trix').toString().slice(0, 9), p.editor.getDocument().toString().slice(0, 9)]))).toEqual([['Hello�� w', 'Hello�� w'], ['Hello�� w', 'Hello�� w']])
})

// Yjs leaves an embed that is not an object out of the change event it
// reports, so the editor never heard of it and was one character short of Y.
test('trix: an embed that is not an object is shown, as a placeholder, by every editor', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { const p = window.ytDemo.peers[1]; p.doc.transact(() => p.doc.getText('trix').insertEmbed(2, 7), 'a peer') })
  expect(await converge(page)).toContain('He�llo')
  await page.evaluate(() => { const e = window.ytDemo.peers[0].editor; e.setSelectedRange([4, 4]); e.insertString('Z') })
  expect(await converge(page)).toContain('He�lZlo')
})
