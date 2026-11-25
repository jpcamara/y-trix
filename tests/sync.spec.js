import { test, expect } from '@playwright/test'
import { open, html, text, caret, converge, docJSON } from './helpers.js'

const mod = 'ControlOrMeta'

test('trix: initial content reaches B', async ({ page }) => {
  await open(page)
  expect(await docJSON(page, 1)).toBe(await docJSON(page, 0))
  expect(await html(page, 1)).toContain('Hello <strong>world</strong>')
  await converge(page)
})

test('trix: typing in A appears in B', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.keyboard.type(' Typed by A.')
  await expect.poll(() => text(page, 1)).toContain('Second paragraph. Typed by A.')
  await converge(page)
})

test('trix: concurrent offline typing in one block converges', async ({ page }) => {
  await open(page)
  await page.uncheck('#online')
  await caret(page, 0, 6)
  await page.keyboard.type('AAA ')
  await caret(page, 1, 6)
  await page.keyboard.type('BBB ')
  await caret(page, 1, 'end')
  await page.keyboard.type(' b-end')
  await page.check('#online')
  const out = await converge(page)
  expect(out).toContain('AAA ')
  expect(out).toContain('BBB ')
  expect(out).toContain(' b-end')
})

test('trix: interleaved typing with network delay converges', async ({ page }) => {
  await open(page)
  await page.fill('#delay', '40')
  for (let k = 0; k < 6; k++) {
    await caret(page, 0, 5)
    await page.keyboard.type('a' + k)
    await caret(page, 1, 5)
    await page.keyboard.type('b' + k)
  }
  const out = await converge(page)
  for (let k = 0; k < 6; k++) { expect(out).toContain('a' + k); expect(out).toContain('b' + k) }
})

test('trix: formatting, headings, lists and quotes sync', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.keyboard.type(' plain ')
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-attribute="bold"]').click()
  await page.keyboard.type('bolded')
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-attribute="bold"]').click()
  await page.keyboard.type(' after')
  await caret(page, 0, 2)
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-attribute="heading1"]').click()
  await caret(page, 0, 'end')
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-attribute="bullet"]').click()
  await page.keyboard.press('Enter')
  await page.keyboard.type('item two')
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-action="increaseNestingLevel"]').click()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('after list')
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-attribute="quote"]').click()
  await converge(page)
  const b = await html(page, 1)
  expect(b).toContain('<strong>bolded</strong>')
  expect(b).toContain('<h1>')
  expect(b).toContain('<ul><li>')
  expect(b).toMatch(/<li>[^]*<ul><li><!--block-->item two/)
  expect(b).toContain('<blockquote>')
})

test('trix: a block split and typing next to it merge', async ({ page }) => {
  await open(page)
  await page.uncheck('#online')
  // A splits "Second paragraph." after "Second" (a heading so Enter breaks the block)
  await caret(page, 0, 'end')
  await page.evaluate(() => { const ed = window.ytDemo.peers[0].editor; ed.activateAttribute('heading1') })
  const start = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().toString().indexOf('Second'))
  await caret(page, 0, start + 6)
  await page.keyboard.press('Enter')
  // B types right where A split, and at the end
  await caret(page, 1, start + 6)
  await page.keyboard.type('-B')
  await caret(page, 1, 'end')
  await page.keyboard.type(' tail')
  await page.check('#online')
  const out = await converge(page)
  // both inserted at the same index; Yjs orders them by client id
  expect(out).toMatch(/Second-B\n paragraph\. tail|Second\n-B paragraph\. tail/)
  const blocks = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getBlocks().length)
  expect(blocks).toBe(3)
})

test('trix: backspace merging two blocks keeps concurrent text in both', async ({ page }) => {
  await open(page)
  await page.uncheck('#online')
  const start = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().toString().indexOf('Second'))
  await caret(page, 0, start)
  await page.keyboard.press('Backspace')
  await caret(page, 1, start - 1)
  await page.keyboard.type(' end-of-first')
  await caret(page, 1, 'end')
  await page.keyboard.type(' end-of-second')
  await page.check('#online')
  const out = await converge(page)
  expect(out).toContain('editor. end-of-firstSecond paragraph. end-of-second')
  expect(await page.evaluate(() => window.ytDemo.peers[1].editor.getDocument().getBlocks().length)).toBe(1)
})

test('trix: a key typed right after Enter lands after the line break', async ({ page }) => {
  await open(page)
  // at the end of the first block, and in the middle of the second
  for (const [pos, want] of [[38, 'Hello world. Edit me in either editor.\nNew\nSecond paragraph.\n'], [46, 'Hello world. Edit me in either editor.\nNew\nSec\nNewond paragraph.\n']]) {
    await caret(page, 0, pos)
    // no pause between the keys: Trix would render the Enter on the next frame
    await page.keyboard.press('Enter')
    await page.keyboard.type('New')
    expect(await converge(page)).toBe(want)
  }
})

test('trix: replacing an emoji with another keeps both whole', async ({ page }) => {
  await open(page)
  await caret(page, 0, 5)
  await page.keyboard.insertText('\u{1F600}')
  expect(await converge(page)).toContain('Hello\u{1F600} world')
  // Most emoji share their first UTF-16 half, so a minimal diff changes one half
  await caret(page, 0, 5)
  await page.evaluate(() => window.ytDemo.peers[0].editor.setSelectedRange([5, 7]))
  await page.waitForTimeout(50)
  await page.keyboard.insertText('\u{1F601}')
  expect(await converge(page)).toContain('Hello\u{1F601} world')
  // insert before an emoji, and a joined sequence between two
  await caret(page, 0, 5)
  await page.keyboard.insertText('\u{1F601}\u{1F600}')
  await converge(page)
  await caret(page, 0, 7)
  await page.keyboard.insertText('\u{1F469}\u200d\u{1F469}\u200d\u{1F467}')
  const want = 'Hello\u{1F601}\u{1F469}\u200d\u{1F469}\u200d\u{1F467}\u{1F600}\u{1F601} world'
  expect(await converge(page)).toContain(want)
  expect(await page.evaluate(() => window.ytDemo.peers[1].doc.getText('trix').toString())).toContain(want)
  // delete the first of the emoji from the other side
  await caret(page, 1, 7)
  await page.keyboard.press('Backspace')
  expect(await converge(page)).toContain('Hello\u{1F469}\u200d\u{1F469}\u200d\u{1F467}\u{1F600}\u{1F601} world')
})

test('trix: remote edits do not move the local caret', async ({ page }) => {
  await open(page)
  const start = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().toString().indexOf('paragraph'))
  await caret(page, 0, start)
  // B edits its model directly: Trix's selection APIs would move the page's
  // one DOM selection, which A owns.
  await page.evaluate(() => {
    const c = window.ytDemo.peers[1].editor.composition
    c.setDocument(c.document.insertTextAtRange(window.Trix.Text.textForStringWithAttributes('Remote text before. '), [0, 0]))
  })
  await expect.poll(() => text(page, 0)).toContain('Remote text before.')
  await page.keyboard.type('local ')
  const out = await converge(page)
  expect(out).toContain('Second local paragraph.')
  expect(out.startsWith('Remote text before. Hello')).toBe(true)
})

test('trix: a remote update does not take the page selection from the other editor', async ({ page }) => {
  await open(page)
  // B has been used, so Trix remembers a selection for it
  await caret(page, 1, 2)
  await page.keyboard.type('b')
  await expect.poll(() => text(page, 0)).toContain('Hebllo')
  await caret(page, 0, 4)
  for (const ch of 'QRS') {
    await page.keyboard.type(ch)
    await page.waitForTimeout(30) // let B render each remote change
  }
  const after = await page.evaluate(() => [document.activeElement.id, document.getElementById('alice').contains(getSelection().anchorNode)])
  expect(after).toEqual(['alice', true])
  const out = await converge(page)
  expect(out.slice(0, 12)).toBe('HeblQRSlo wo')
})

test('trix: undo in A does not remove B\'s edit', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.keyboard.type(' from-A')
  await page.waitForTimeout(600)
  await caret(page, 1, 0)
  await page.keyboard.type('from-B ')
  await expect.poll(() => text(page, 0)).toContain('from-B')
  // place the caret, not just focus: WebKit sends undo to the editor holding the selection
  await caret(page, 0, 'end')
  await page.keyboard.press(`${mod}+z`)
  let out = await converge(page)
  expect(out).not.toContain('from-A')
  expect(out).toContain('from-B')
  await page.keyboard.press(`${mod}+Shift+z`)
  out = await converge(page)
  expect(out).toContain('from-A')
  expect(out).toContain('from-B')
  // toolbar buttons follow the Y undo stack
  expect(await page.evaluate(() => window.ytDemo.peers[0].editor.canUndo())).toBe(true)
  expect(await page.evaluate(() => window.ytDemo.peers[1].editor.canUndo())).toBe(true)
})

test('trix: remote cursor is drawn as an overlay, not in content', async ({ page }) => {
  await open(page)
  await caret(page, 1, 4)
  await page.keyboard.type('b')
  await expect.poll(() => page.locator('[data-y-caret]').count()).toBeGreaterThan(0)
  expect(await html(page, 0)).not.toContain('data-y-caret')
  await converge(page)
})

test('trix: a late joiner gets the full document', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.keyboard.type(' before join')
  await page.evaluate(() => window.ytDemo.addPeer())
  await converge(page, 3)
  expect(await text(page, 2)).toContain('before join')
})

test('trix: attachments sync, keep their identity, and take attribute changes', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.evaluate(() => {
    const ed = window.ytDemo.peers[0].editor
    const att = new window.Trix.Attachment({ content: '<span class="mention">@carol</span>', contentType: 'mention' })
    ed.insertAttachment(att)
    ed.insertString(' and ')
    window.img = new window.Trix.Attachment({ url: '/demo/assets/none.png', contentType: 'image/png', filename: 'none.png', width: 10, height: 10 })
    ed.insertAttachment(window.img)
  })
  await converge(page)
  expect(await html(page, 1)).toContain('@carol')
  // B edits around the attachment; A's attachment objects survive the remote rebuild
  const ids = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getAttachments().map((a) => a.id).join())
  await caret(page, 1, 'end')
  await page.keyboard.type(' typed by B')
  await converge(page)
  expect(await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getAttachments().map((a) => a.id).join())).toBe(ids)
  // an upload finishing changes attributes in place
  await page.evaluate(() => window.img.setAttributes({ url: '/demo/assets/uploaded.png', href: '/demo/assets/uploaded.png' }))
  await converge(page)
  expect(await docJSON(page, 1)).toContain('uploaded.png')
})

test('trix: undoing an attachment attribute change gives every editor the old attachment', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.evaluate(() => {
    const p = window.ytDemo.peers[0]
    window.att = new window.Trix.Attachment({ content: '<span class="mention">@carol</span>', contentType: 'mention' })
    p.editor.insertAttachment(window.att)
    p.binding.undoManager.stopCapturing()
  })
  await converge(page)
  // changed in place, as a link applied over the attachment does
  await page.evaluate(() => window.att.setAttributes({ href: 'https://example.com/carol' }))
  await converge(page)
  expect(await docJSON(page, 1)).toContain('example.com/carol')
  await page.evaluate(() => window.ytDemo.peers[0].editor.undo())
  await converge(page)
  expect(await docJSON(page, 0)).not.toContain('example.com/carol')
  expect(await docJSON(page, 0)).toContain('@carol')
  await page.evaluate(() => window.ytDemo.peers[0].editor.redo())
  await converge(page)
  expect(await docJSON(page, 0)).toContain('example.com/carol')
})

test('trix: applying remote changes does not echo updates', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    window.echo = 0
    const b = window.ytDemo.peers[1]
    b.doc.on('update', (u, origin) => { if (origin !== 'remote') window.echo++ })
  })
  await caret(page, 0, 'end')
  await page.keyboard.type(' no echo')
  await page.locator('#alice').locator('xpath=..').locator('[data-trix-attribute="quote"]').click()
  await converge(page)
  expect(await page.evaluate(() => window.echo)).toBe(0)
})

for (const seed0 of (process.env.FUZZ_SEEDS || '7').split(',').map(Number)) test(`trix: random command fuzz converges (seed ${seed0})`, async ({ page }) => {
  await open(page)
  await page.fill('#delay', process.env.FUZZ_DELAY || '15')
  const ops = ['type', 'type', 'type', 'enter', 'bold', 'backspace', 'bullet', 'heading', 'quote', ...(process.env.FUZZ_NO_UNDO ? [] : ['undo'])]
  let seed = seed0
  const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
  for (let k = 0; k < Number(process.env.FUZZ_OPS || 40); k++) {
    const peer = rand(2)
    const len = await page.evaluate((i) => window.ytDemo.peers[i].editor.getDocument().getLength(), peer)
    await caret(page, peer, rand(len))
    const op = ops[rand(ops.length)]
    if (op === 'type') await page.keyboard.type(['x', 'yy', 'zz z'][rand(3)])
    else if (op === 'enter') await page.keyboard.press('Enter')
    else if (op === 'backspace') await page.keyboard.press('Backspace')
    else if (op === 'bold') {
      await page.keyboard.press('Shift+ArrowLeft')
      await page.evaluate((i) => { const ed = window.ytDemo.peers[i].editor; ed.attributeIsActive('bold') ? ed.deactivateAttribute('bold') : ed.activateAttribute('bold') }, peer)
    }
    else if (op === 'undo') await page.keyboard.press(`${mod}+z`)
    else {
      await page.evaluate(({ i, name }) => {
        const ed = window.ytDemo.peers[i].editor
        if (ed.attributeIsActive(name)) ed.deactivateAttribute(name)
        else if (ed.canActivateAttribute(name)) ed.activateAttribute(name)
      }, { i: peer, name: op === 'heading' ? 'heading1' : op })
    }
  }
  await converge(page)
})

test('trix: an undo that throws in Yjs leaves the editor matching Y', async ({ page }) => {
  await open(page)
  await caret(page, 0, 'end')
  await page.keyboard.type(' typed')
  // Stand-in for yjs/yjs#809: change Y as the undo manager, then throw.
  const escaped = await page.evaluate(() => {
    const { binding, doc, editor } = window.ytDemo.peers[0]
    const um = binding.undoManager
    um.undo = () => {
      doc.transact(() => { doc.getText('trix').delete(0, 6) }, um)
      throw new Error('simulated Yjs failure')
    }
    try { editor.undo() } catch (e) { return e.message }
    return null
  })
  expect(escaped).toBe(null)
  const out = await converge(page)
  expect(out.startsWith('world.')).toBe(true)
})
