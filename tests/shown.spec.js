// The others have to be shown where the user is after every key and every
// toolbar button: the caret a user publishes is the place their own editor
// has it. (A toolbar button takes the focus for a moment in some browsers;
// what it did then was not published until the user moved.)
// SHOWN_SEEDS=1,2,3 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'
const KEYS = ['Enter', 'Shift+Enter', 'Backspace', 'Delete', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Shift+ArrowRight', 'Shift+ArrowLeft', 'Home', 'End', 'x', 'y', 'z']
// (no spaces: two in a row at the start of a line lose one when Firefox and Trix handle Shift+Enter, bound or not, and Trix's own idea of the caret is then one off)
const ACTIONS = ['bold', 'italic', 'strike', 'heading1', 'quote', 'code', 'bullet', 'number', 'increaseNestingLevel', 'decreaseNestingLevel', 'undo', 'redo']
for (const seed0 of (process.env.SHOWN_SEEDS || '1,2,3').split(',').map(Number)) {
  test(`the others are shown where the user is after every key and button (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(120000)
    await open(page)
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const toolbar = '#' + await page.evaluate(() => window.ytDemo.peers[0].element.toolbarElement.id)
    const wrong = []
    for (let k = 0; k < 70; k++) {
      let did
      if (rand(10) === 0) { const len = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getLength()); did = 'caret'; await caret(page, 0, rand(len)).catch(() => {}) } else if (rand(3) === 0) {
        const name = ACTIONS[rand(ACTIONS.length)]
        did = name
        await page.locator(`${toolbar} [data-trix-attribute=${name}], ${toolbar} [data-trix-action=${name}]`).first().click({ timeout: 800 }).catch(() => { did += ' (disabled)' })
      } else {
        // (only with the focus in the editor: a key pressed with the focus on the page can leave the page)
        if (!(await page.evaluate(() => document.activeElement === window.ytDemo.peers[0].element))) await caret(page, 0, 0).catch(() => {})
        did = KEYS[rand(KEYS.length)]
        await page.keyboard.press(did)
      }
      await page.waitForTimeout(60)
      const seen = await page.evaluate(() => {
        const [a, b] = window.ytDemo.peers
        const Y = window.ytDemo.Y
        const focused = document.activeElement === a.element
        // (as the binding reads it: Chromium's Trix takes a selected block break for a caret)
        const sel = a.binding.safeSelectedRange()
        const state = b.awareness.getStates().get(a.awareness.clientID)
        const cursor = state && state.cursor
        const at = (json) => { const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), b.doc); return abs ? abs.index : null }
        const shown = cursor ? [at(cursor.anchor), at(cursor.head)].sort((x, y) => x - y) : null
        return { focused, sel, shown, same: JSON.stringify(a.doc.getText('trix').toDelta()) === JSON.stringify(b.doc.getText('trix').toDelta()) }
      })
      if (seen.focused && seen.same && seen.sel && (seen.shown === null || seen.shown[0] !== seen.sel[0] || seen.shown[1] !== seen.sel[1])) wrong.push({ k, did, ...seen })
    }
    if (wrong.length) console.log('SHOWN', seed0, wrong.length, JSON.stringify(wrong.slice(0, 5)).slice(0, 1200))
    expect(wrong.map((w) => w.did)).toEqual([])
    await converge(page)
  })
}
