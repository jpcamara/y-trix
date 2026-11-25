// Typing through an input method (Japanese here) while remote changes
// arrive. Uses the DevTools protocol to drive a composition, so Chromium only.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

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
