// The binding must not change what Trix does for the user. Two pages get
// the same keys, toolbar buttons and pastes, chosen at random: one with the
// binding (and a second editor that only receives), one with Trix alone.
// After every step both have to hold the same document and the same
// selection. ALONE_SEEDS=1,2,3 ALONE_STEPS=120 pick the runs.
// ALONE_NOISE=1 has someone else type a character and take it away again,
// or make two characters bold and plain again, between the steps: the
// document ends as it was, and the blocks the user is in are drawn again
// under them. In Chromium about one run in ten then has a key on the other
// side of a space typed just before a line break made with Shift+Enter
// (see Limits of the approach in docs/how-it-works.md).
import { test, expect } from '@playwright/test'
import { open, docJSON } from './helpers.js'

const KEYS = ['Enter', 'Shift+Enter', 'Backspace', 'Backspace', 'Delete', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Shift+ArrowRight', 'Shift+ArrowLeft', 'Home', 'End', 'Space', 'Tab']
const BUTTONS = ['bold', 'italic', 'strike', 'heading1', 'quote', 'code', 'bullet', 'number', 'increaseNestingLevel', 'decreaseNestingLevel']
const NOISE = !!process.env.ALONE_NOISE
const PASTES = ['<figure data-trix-attachment="{&quot;contentType&quot;:&quot;image/gif&quot;,&quot;filename&quot;:&quot;a.gif&quot;,&quot;filesize&quot;:35,&quot;height&quot;:20,&quot;url&quot;:&quot;data:image/gif;base64,R0lGODlhAQABAAAAACw=&quot;,&quot;width&quot;:20}" data-trix-content-type="image/gif" class="attachment attachment--preview"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"></figure>', '<figure data-trix-attachment="{&quot;content&quot;:&quot;<b>@m</b>&quot;,&quot;contentType&quot;:&quot;mention&quot;}" data-trix-content-type="mention" class="attachment attachment--content"><b>@m</b></figure>', '<div>one</div><div>two <em>three</em></div>', '<ul><li>a</li><li>b</li></ul>', 'plain <strong>bold</strong> text', '<h1>Title</h1><blockquote>quote</blockquote>', '<pre>code\nlines</pre>', 'x  y   z', ' lead and trail ']

for (const seed0 of (process.env.ALONE_SEEDS || '1,2,3').split(',').map(Number)) {
  test(`trix: the same keys give the same document with the binding and without (seed ${seed0})`, async ({ page, context }) => {
    test.setTimeout(180000)
    const plain = await context.newPage()
    for (const p of [page, plain]) await open(p)
    await plain.evaluate(() => window.ytDemo.peers.forEach((p) => p.binding.destroy()))
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const both = async (fn) => { for (const p of [page, plain]) { await p.bringToFront(); await fn(p) } }
    const state = (p) => p.evaluate(() => { const ed = window.ytDemo.peers[0].editor; return JSON.stringify([window.ytNorm(ed.getDocument()), ed.getSelectedRange()]) })
    await docJSON(page, 0); await docJSON(plain, 0)
    const toolbar = '#' + await page.evaluate(() => window.ytDemo.peers[0].element.toolbarElement.id)
    await both((p) => p.evaluate(() => window.ytDemo.peers[0].element.focus()))
    const log = []
    const moved = []
    for (let k = 0; k < Number(process.env.ALONE_STEPS || 80); k++) {
      // Someone else, in the page with the binding: a character typed
      // somewhere and taken away again, or two characters made bold and
      // plain again. The document ends as it was, and on the way the blocks
      // the user is working in are drawn again under them.
      if (NOISE && rand(2) === 0) {
        const kind = rand(2)
        const r0 = rand(100000)
        for (const phase of [0, 1]) {
          await page.evaluate(({ r0, kind, phase }) => {
            const p = window.ytDemo.peers[1]
            const t = p.doc.getText('trix')
            const delta = t.toDelta()
            const units = delta.map((op) => (typeof op.insert === 'string' ? op.insert : '\ufffc')).join('')
            const bold = []
            for (const op of delta) { const n = typeof op.insert === 'string' ? op.insert.length : 1; for (let k = 0; k < n; k++) bold.push(!!(op.attributes && op.attributes.bold)) }
            const ok = (k) => k >= 0 && k < units.length && units[k] !== '\n' && units[k] !== '\ufffc' && units[k] !== ' ' && units[k] !== '\u00a0' && !(units.charCodeAt(k) >= 0xd800 && units.charCodeAt(k) <= 0xdfff)
            if (phase === 0) {
              let at = r0 % Math.max(1, units.length)
              const fits = (k) => ok(k) && ok(k - 1) && ok(k + 1) && ok(k + 2) && (kind === 0 || (!bold[k] && !bold[k + 1]))
              for (let tries = 0; tries < 40 && !fits(at); tries++) at = (at + 7) % Math.max(1, units.length)
              window.noiseAt = fits(at) ? at : -1
              if (window.noiseAt < 0) return
              if (kind === 0) p.doc.transact(() => t.insert(at, '\u00a7', delta.length ? (() => { let pos = 0; for (const op of delta) { const n = typeof op.insert === 'string' ? op.insert.length : 1; if (at - 1 < pos + n) return { ...(op.attributes || {}) }; pos += n } return {} })() : {}), 'a peer')
              else p.doc.transact(() => t.format(at, 2, { bold: true }), 'a peer')
            } else if (window.noiseAt >= 0) {
              if (kind === 0) { const now = t.toDelta().map((op) => (typeof op.insert === 'string' ? op.insert : '\ufffc')).join('').indexOf('\u00a7'); if (now >= 0) p.doc.transact(() => t.delete(now, 1), 'a peer') } else p.doc.transact(() => t.format(window.noiseAt, 2, { bold: null }), 'a peer')
            }
          }, { r0, kind, phase })
          await page.waitForTimeout(40)
        }
      }
      const r = rand(10)
      let did
      if (r === 0) {
        const len = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getLength())
        const at = rand(len); const span = rand(3) === 0 ? rand(8) : 0
        did = `select ${at}+${span}`
        await both((p) => p.evaluate(({ at, span }) => { const ed = window.ytDemo.peers[0].editor; window.ytDemo.peers[0].element.focus(); ed.setSelectedRange([at, Math.min(at + span, ed.getDocument().getLength() - 1)]) }, { at, span }))
      } else if (r === 1) {
        const name = BUTTONS[rand(BUTTONS.length)]
        did = name
        await both((p) => p.locator(`${toolbar} [data-trix-attribute=${name}], ${toolbar} [data-trix-action=${name}]`).first().click({ timeout: 600 }).catch(() => {}))
      } else if (r === 2) {
        const html = PASTES[rand(PASTES.length)]
        did = 'paste ' + html
        await both((p) => p.evaluate((html) => window.ytDemo.peers[0].editor.insertHTML(html), html))
      } else if (r < 6) {
        did = KEYS[rand(KEYS.length)]
        await both(async (p) => { if (!(await p.evaluate(() => document.activeElement === window.ytDemo.peers[0].element))) await p.evaluate(() => window.ytDemo.peers[0].element.focus()); await p.keyboard.press(did) })
      } else {
        // (not faster than a person: Trix alone loses or misplaces a key that comes in the same frame as the one before)
        did = 'type ' + ['a', 'b ', 'word', ' x', 'Q.'][rand(5)]
        await both(async (p) => { if (!(await p.evaluate(() => document.activeElement === window.ytDemo.peers[0].element))) await p.evaluate(() => window.ytDemo.peers[0].element.focus()); await p.keyboard.type(did.slice(5), { delay: 30 }) })
      }
      log.push(did)
      await page.waitForTimeout(30)
      let [a, b] = [await state(page), await state(plain)]
      if (a !== b && JSON.parse(a)[0] === JSON.parse(b)[0]) {
        // The same document with the caret somewhere else: a key (End, an
        // arrow) now and then does nothing in one of the two pages, with the
        // binding or without. Not more than a few times in a run, and the
        // two carry on from the same place.
        moved.push(did)
        const sel = JSON.parse(a)[1]
        await plain.evaluate((sel) => window.ytDemo.peers[0].editor.setSelectedRange(sel), sel)
        ;[a, b] = [await state(page), await state(plain)]
      }
      if (a !== b) {
        let i = 0
        while (i < a.length && a[i] === b[i]) i++
        console.log('ALONE', seed0, 'step', k, JSON.stringify(log.slice(-6)), '\n bound: ' + a.slice(Math.max(0, i - 120), i + 160) + '\n alone: ' + b.slice(Math.max(0, i - 120), i + 160))
      }
      expect(a === b, `after step ${k} (${did})`).toBe(true)
    }
    expect(moved.length, 'steps after which only the caret differed: ' + moved.join(', ')).toBeLessThan(4)
    // and the editor that only received holds it too
    await expect.poll(async () => (await docJSON(page, 1)) === (await docJSON(page, 0))).toBe(true)
    expect(page.debugFailures).toEqual([])
  })
}
