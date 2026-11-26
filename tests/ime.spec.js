// Typing through an input method (Japanese here) while remote changes
// arrive. Uses the DevTools protocol to drive a composition, so Chromium only.
import { test, expect } from '@playwright/test'
import { open, caret, converge, text } from './helpers.js'

// where the peer inserts while A composes at position 5
const cases = { 'earlier in the same block': 0, 'later in the same block': 20, 'in another block': 45, nowhere: null }
for (const [where, at] of Object.entries(cases)) {
  test(`trix: a composition survives remote changes ${where}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs the DevTools protocol')
    await open(page)
    await caret(page, 0, 5)
    const cdp = await page.context().newCDPSession(page)
    const remote = async (tag) => {
      if (at === null) return
      await page.evaluate(({ at, tag }) => { const p = window.ytDemo.peers[1]; p.doc.transact(() => p.doc.getText('trix').insert(at, tag), 'a peer') }, { at, tag })
      await page.waitForTimeout(60)
    }
    await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
    await remote('[R1]')
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
    await remote('[R2]')
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
    await remote('[R3]')
    await cdp.send('Input.insertText', { text: '日本' })
    await page.waitForTimeout(100)
    // the caret is still right after the composed text
    await page.keyboard.type('!')
    const out = await converge(page)
    // only the committed text, never the half-typed "n", "に" or "にほん"
    expect(out.replace(/\[R\d\]/g, '')).toBe('Hello日本! world. Edit me in either editor.\nSecond paragraph.\n')
    if (at !== null) for (const tag of ['[R1]', '[R2]', '[R3]']) expect(out).toContain(tag)
  })
}

// An emoji split by an edit inside it is written as U+FFFD (see flushLocal).
// During a composition the editor must not be redrawn, so it shows the
// U+FFFD when the composition ends. Found by the wide fuzz in Firefox, where
// a typed "é" arrives as a composition.
test('trix: an emoji split during a composition reads the same everywhere afterwards', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const p = window.ytDemo.peers[0]
    p.editor.setSelectedRange([0, 0])
    p.editor.insertString('\u{1F600}')
  })
  await converge(page)
  await page.evaluate(() => {
    const p = window.ytDemo.peers[0]
    p.element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    p.editor.setSelectedRange([1, 1])
    p.editor.insertString('é')
    p.element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }))
  })
  await converge(page)
  expect(await text(page, 0)).toContain('�é�')
  expect(await text(page, 1)).toContain('�é�')
})

// Harder: while A composes at position 5 (after "Hello"), a peer changes the
// formatting or the structure of that very block.
const hard = {
  'bold later in the block': (t) => t.format(8, 4, { bold: true }),
  'bold over the text before the caret': (t) => t.format(0, 5, { bold: true }),
  'bold over the whole block': (t) => t.format(0, 30, { bold: true }),
  'a link around the caret': (t) => t.format(3, 5, { href: 'https://example.com/' }),
  'the block made a heading': (t) => t.format(t.toString().indexOf('\n'), 1, { block: ['heading1'] }),
  'the block put in a list': (t) => t.format(t.toString().indexOf('\n'), 1, { block: ['bulletList', 'bullet'] }),
  'Enter before the caret': (t) => t.insert(3, '\n', { blockBreak: true }),
  'Enter right at the caret': (t) => t.insert(5, '\n', { blockBreak: true }),
  'text before the caret deleted': (t) => t.delete(1, 3),
  'the text around the caret deleted': (t) => t.delete(3, 5),
  'the block joined to the next': (t) => t.delete(t.toString().indexOf('\n'), 1),
  'an attachment before the caret': (t) => t.insertEmbed(2, { attachment: { content: '<b>@m</b>', contentType: 'mention' } }),
  'an attachment at the caret': (t) => t.insertEmbed(5, { attachment: { content: '<b>@m</b>', contentType: 'mention' } })
}
for (const [what, change] of Object.entries(hard)) {
  for (const when of ['early', 'late']) {
    test(`trix: a composition and a remote change to its block: ${what}, ${when}`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'needs the DevTools protocol')
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      if (process.env.STRICT) page.on('console', (m) => { if (m.text().includes('did not show what Y holds')) errors.push(m.text()) })
      await open(page)
      await caret(page, 0, 5)
      const cdp = await page.context().newCDPSession(page)
      const remote = async () => {
        await page.evaluate((src) => {
          const p = window.ytDemo.peers[1]
          // eslint-disable-next-line no-eval
          p.doc.transact(() => (0, eval)('(' + src + ')')(p.doc.getText('trix')), 'a peer')
        }, change.toString())
        await page.waitForTimeout(80)
      }
      await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
      if (when === 'early') await remote()
      await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 })
      await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 })
      if (when === 'late') await remote()
      await cdp.send('Input.insertText', { text: '日本' })
      await page.waitForTimeout(150)
      await page.keyboard.type('!')
      await page.waitForTimeout(350)
      const out = await converge(page)
      // what was committed is there once, with the next key right after it, and nothing half-typed
      expect(out.split('日本!').length).toBe(2)
      expect(out.split('日本').length).toBe(2)
      expect(out).not.toMatch(/に|ほ|ん/)
      expect(errors).toEqual([])
    })
  }
}

// A slow composition (the user looks through the candidates) is still one
// undo step: undo takes the committed word out, and never brings half-typed
// text back. Yjs alone starts a new step after every pause.
test('trix: undo after a slow composition takes out the whole word', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'needs the DevTools protocol')
  await open(page)
  await caret(page, 0, 5)
  await page.keyboard.type('X')
  await page.waitForTimeout(700)
  const cdp = await page.context().newCDPSession(page)
  for (const s of ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん']) {
    await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await page.waitForTimeout(350)
  }
  await page.waitForTimeout(400)
  await cdp.send('Input.insertText', { text: '日本' })
  await page.waitForTimeout(700)
  expect(await converge(page)).toContain('HelloX日本 world.')
  await page.evaluate(() => window.ytDemo.peers[0].editor.undo())
  const once = await converge(page)
  expect(once).not.toMatch(/に|ほ|ん|n world/)
  expect(once).toContain('HelloX world.')
  await page.evaluate(() => window.ytDemo.peers[0].editor.undo())
  expect(await converge(page)).toContain('Hello world.')
  await page.evaluate(() => { const ed = window.ytDemo.peers[0].editor; ed.redo(); ed.redo() })
  const again = await converge(page)
  expect(again).toContain('HelloX日本 world.')
  expect(again).not.toMatch(/に|ほ|ん/)
})
