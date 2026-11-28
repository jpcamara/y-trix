// What a user is in the middle of has to survive what the others do: a click
// that has just been made, a selection being dragged with the mouse, a
// selection made backwards with the keyboard, a format switched on for the
// next key, the link dialog with words selected, an image clicked. Each round the user starts
// one of these with real mouse and keys, two others edit at random in Y, and
// the user finishes. Where the ends of a selection belong is told by Yjs
// relative positions taken before the others' edits.
// UI_SEEDS=1,2,3 UI_ROUNDS=40 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

for (const seed0 of (process.env.UI_SEEDS || '1,2,3').split(',').map(Number)) {
  test(`trix: what the user is in the middle of survives the others' edits (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(240000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const toolbar = '#' + await page.evaluate(() => window.ytDemo.peers[0].element.toolbarElement.id)
    const wrong = []
    const judged = {}

    // the others edit, in Y (text someone else types exactly at a point goes after it)
    const others = () => page.evaluate(({ s, n }) => {
      let seed = s
      const rand = (k) => { seed = (seed * 16807) % 2147483647; return seed % k }
      const pick = (a) => a[rand(a.length)]
      const did = []
      for (let i = 0; i < n; i++) {
        const p = window.ytDemo.peers[1 + rand(2)]
        const t = p.doc.getText('trix')
        const units = t.toString()
        const low = (k) => k > 0 && k < units.length && units.charCodeAt(k) >= 0xdc00 && units.charCodeAt(k) <= 0xdfff
        const snap = (k) => (low(k) ? k + 1 : k)
        const pos = snap(rand(t.length))
        const count = (k) => Math.max(0, snap(Math.min(pos + k, t.length - 1)) - pos)
        const op = pick(['type', 'type', 'type', 'type', 'enter', 'delete', 'range-delete', 'bold', 'heading', 'quote', 'emoji'])
        did.push(op + '@' + pos)
        p.doc.transact(() => {
          if (op === 'type') t.insert(pos, pick(['x', 'yy', 'zz z']), {})
          else if (op === 'emoji') t.insert(pos, '\u{1F600}', {})
          else if (op === 'enter') t.insert(pos, '\n', { blockBreak: true })
          else if (op === 'delete') { if (count(1) > 0) t.delete(pos, count(1)) } else if (op === 'range-delete') { if (count(1) > 0) t.delete(pos, count(2 + rand(6))) } else if (op === 'bold') { if (count(1) > 0) t.format(pos, count(1 + rand(8)), { bold: true }) } else {
            const next = units.indexOf('\n', pos)
            if (next >= 0) t.format(next, 1, { block: op === 'heading' ? ['heading1'] : ['quote'] })
          }
        }, 'a peer')
      }
      return did
    }, { s: 1 + rand(2147483000), n: 1 + rand(3) })

    // the user's selection as the page has it, in document positions, and which way it runs
    const selection = () => page.evaluate(() => {
      const { editor } = window.ytDemo.peers[0]
      const manager = window.ytDemo.peers[0].element.editorController.selectionManager
      const now = manager.getLocationRange({ strict: false })
      const s = window.getSelection()
      let backwards = false
      if (s.rangeCount > 0 && !s.isCollapsed) { const r = document.createRange(); r.setStart(s.focusNode, s.focusOffset); r.setEnd(s.anchorNode, s.anchorOffset); backwards = !r.collapsed }
      return { range: now ? editor.getDocument().rangeFromLocationRange(now) : null, backwards }
    })
    // note where a range is, to be asked again after the others' edits
    const note = (range) => page.evaluate((range) => {
      const { doc } = window.ytDemo.peers[0]
      const Y = window.ytDemo.Y
      const type = doc.getText('trix')
      window.noted = range.map((index) => Y.createRelativePositionFromTypeIndex(type, Math.min(index, type.length), -1))
    }, range)
    const noted = () => page.evaluate(() => {
      const { doc, editor } = window.ytDemo.peers[0]
      const Y = window.ytDemo.Y
      const last = editor.getDocument().getLength() - 1
      const want = window.noted.map((rel) => { const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc); return abs === null ? null : Math.min(abs.index, last) })
      const alive = window.noted.every((rel) => rel.item === null || !Y.getItem(doc.store, rel.item).deleted)
      return { want, alive }
    })
    const point = (index) => page.evaluate((index) => {
      const rect = window.ytDemo.peers[0].editor.getClientRectAtPosition(index)
      return rect ? { x: rect.left + 1, y: rect.top + rect.height / 2 } : null
    }, index)
    const shown = () => page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().toString())
    const judge = (kind, ok, detail) => { judged[kind] = (judged[kind] || 0) + 1; if (!ok) wrong.push({ kind, ...detail }) }

    for (let round = 0; round < Number(process.env.UI_ROUNDS || 30); round++) {
      const len = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getLength())
      const at = rand(len)
      const kind = ['click', 'drag', 'backwards', 'format', 'dialog', 'attachment'][rand(6)]
      await caret(page, 0, 0).catch(() => {})
      if (kind === 'click') {
        const p = await point(at)
        if (!p) continue
        await page.mouse.move(p.x, p.y)
        await page.mouse.down()
        await page.mouse.up()
        const had = await selection()
        if (!had.range) continue
        await note(had.range)
        const did = await others()
        await page.waitForTimeout(60)
        const now = await noted()
        const sel = await selection()
        if (now.alive) judge(kind, !!sel.range && sel.range[0] === now.want[0] && sel.range[1] === now.want[1], { round, did, had: had.range, want: now.want, got: sel.range })
        // and a key lands there
        const ch = String.fromCharCode(0x4e00 + round)
        await page.keyboard.type(ch)
        if (now.alive) judge('key after click', (await shown()).indexOf(ch) === now.want[0], { round, did, want: now.want[0], got: (await shown()).indexOf(ch) })
      } else if (kind === 'drag') {
        const span = 2 + rand(8)
        const from = await point(at)
        const to = await point(Math.min(at + span, len - 1))
        if (!from || !to || Math.abs(from.y - to.y) > 2 || to.x - from.x < 4) continue
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 2 })
        await page.mouse.move(to.x, to.y, { steps: 2 })
        const had = await selection()
        if (!had.range || had.range[0] === had.range[1]) { await page.mouse.up(); continue }
        await note(had.range)
        const before = await shown()
        const did = await others()
        await page.waitForTimeout(80)
        // nothing is drawn while the button is down
        judge('held while dragging', (await shown()) === before, { round, did })
        await page.mouse.move(to.x, to.y + 1)
        await page.mouse.move(to.x, to.y)
        await page.mouse.up()
        await page.waitForTimeout(80)
        const now = await noted()
        const sel = await selection()
        if (now.alive) judge(kind, !!sel.range && sel.range[0] === now.want[0] && sel.range[1] === now.want[1], { round, did, had: had.range, want: now.want, got: sel.range })
      } else if (kind === 'attachment') {
        // an image is clicked, the others edit, and Backspace takes out that image and nothing else
        const where = () => page.evaluate(() => { let pos = 0; for (const op of window.ytDemo.peers[0].doc.getText('trix').toDelta()) { if (typeof op.insert !== 'string') return pos; pos += op.insert.length } return -1 })
        if (await where() < 0) {
          await caret(page, 0, at)
          await page.evaluate((round) => window.ytDemo.peers[0].editor.insertAttachment(new window.Trix.Attachment({ url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', contentType: 'image/gif', filename: round + '.gif', filesize: 35, width: 40, height: 40 })), round)
          await page.evaluate(() => window.ytDemo.syncAll())
          await page.waitForTimeout(60)
        }
        const figure = page.locator('trix-editor').first().locator('figure img').first()
        if (!(await figure.click({ timeout: 2000 }).then(() => true, () => false))) continue
        const state = () => page.evaluate(() => { const ed = window.ytDemo.peers[0].editor; return { editing: !!ed.composition.editingAttachment, range: ed.getSelectedRange(), count: ed.getDocument().getAttachments().length, text: ed.getDocument().toString().replace(/[\ufffc\n]/g, '') } })
        const had = await state()
        if (!had.editing) continue
        const did = await others()
        await page.waitForTimeout(60)
        // (on a slow machine the others' edits can still be on their way: wait for the text to stand still)
        for (let k = 0, last = null; k < 12; k++) { const t = (await state()).text; if (t === last) break; last = t; await page.waitForTimeout(60) }
        const now = await state()
        const pos = await where()
        // (someone can have deleted it)
        if (now.count === 1 && pos >= 0) {
          judge(kind, now.editing && now.range[0] === pos && now.range[1] === pos + 1, { round, did, had, now, pos })
          await page.keyboard.press('Backspace')
          await page.waitForTimeout(40)
          const after = await state()
          // (the text is as it was; a block that held only the image can go with it)
          judge('Backspace on a selected attachment', after.count === 0 && after.text === now.text, { round, did, now, after })
        }
      } else if (kind === 'backwards') {
        await caret(page, 0, at)
        const steps = 1 + rand(5)
        for (let k = 0; k < steps; k++) await page.keyboard.press('Shift+ArrowLeft')
        const had = await selection()
        if (!had.range || had.range[0] === had.range[1]) continue
        await note(had.range)
        const did = await others()
        await page.waitForTimeout(60)
        const now = await noted()
        const sel = await selection()
        if (now.alive && now.want[0] !== now.want[1]) judge(kind, !!sel.range && sel.range[0] === now.want[0] && sel.range[1] === now.want[1] && sel.backwards === had.backwards, { round, did, had, want: now.want, got: sel })
      } else if (kind === 'format') {
        await caret(page, 0, at)
        const name = ['italic', 'bold', 'strike'][rand(3)]
        if (!(await page.locator(`${toolbar} [data-trix-attribute=${name}]`).click({ timeout: 1500 }).then(() => true, () => false))) continue
        const want = await page.evaluate((name) => window.ytDemo.peers[0].editor.attributeIsActive(name), name)
        const did = await others()
        await page.waitForTimeout(60)
        const ch = String.fromCharCode(0x4e00 + round)
        await page.keyboard.type(ch)
        const got = await page.evaluate(({ ch, name }) => { const op = window.ytDemo.peers[0].doc.getText('trix').toDelta().find((d) => typeof d.insert === 'string' && d.insert.includes(ch)); return op ? !!(op.attributes || {})[name] : null }, { ch, name })
        // (in a heading or a code block Trix has no bold: only what it let the user switch)
        judge(kind, got === want, { round, did, name, want, got })
      } else {
        const span = 2 + rand(8)
        await caret(page, 0, at)
        await page.evaluate(({ at, span }) => { const ed = window.ytDemo.peers[0].editor; ed.setSelectedRange([at, Math.min(at + span, ed.getDocument().getLength() - 1)]) }, { at, span })
        const had = (await selection()).range
        const button = page.locator(`${toolbar} [data-trix-attribute=href]`).first()
        if (!had || had[0] === had[1] || await button.isDisabled()) continue
        await button.click()
        const input = page.locator(`${toolbar} input[name=href]`)
        if (!(await input.isVisible())) continue
        // (Trix widens a selection that touches a link to the whole link; and
        // the start of what is selected stays after what is typed just before it)
        await page.evaluate(() => {
          const { doc, editor } = window.ytDemo.peers[0]
          const Y = window.ytDemo.Y
          const type = doc.getText('trix')
          const range = editor.getSelectedRange()
          window.noted = [Y.createRelativePositionFromTypeIndex(type, range[0], 0), Y.createRelativePositionFromTypeIndex(type, range[1], -1)]
        })
        const did = await others()
        await page.waitForTimeout(60)
        const now = await noted()
        const marked = await page.evaluate(() => window.ytDemo.peers.map((p) => JSON.stringify(p.doc.getText('trix').toDelta()).includes('frozen')))
        judge('the held selection is not shared', !marked.includes(true), { round, did })
        const url = 'https://example.com/' + round
        const cancel = rand(4) === 0
        if (cancel) await input.press('Escape')
        else { await input.fill(url); await input.press('Enter') }
        await page.waitForTimeout(60)
        const out = await page.evaluate((url) => {
          const { doc, editor } = window.ytDemo.peers[0]
          let pos = 0; let from = -1; let to = -1
          for (const op of doc.getText('trix').toDelta()) {
            const n = typeof op.insert === 'string' ? op.insert.length : 1
            if ((op.attributes || {}).href === url) { if (from < 0) from = pos; to = pos + n }
            pos += n
          }
          return { from, to, highlight: window.ytDemo.peers[0].element.innerHTML.includes('highlight'), sel: editor.getSelectedRange() }
        }, url)
        judge('nothing left highlighted', !out.highlight, { round, did })
        // (with nothing left of the words, Trix puts the address in as text)
        if (!cancel && now.alive && now.want[0] !== null && now.want[1] > now.want[0]) judge(kind, out.from === now.want[0] && out.to === now.want[1], { round, did, had, want: now.want, got: [out.from, out.to] })
      }
      if (round % 6 === 5) {
        await page.evaluate(() => window.ytDemo.syncAll())
        await converge(page, 3)
      }
    }
    if (wrong.length > 0) console.log('UI', seed0, wrong.length, JSON.stringify(wrong.slice(0, 6)).slice(0, 5000))
    expect(wrong.map((w) => w.kind)).toEqual([])
    await page.evaluate(() => window.ytDemo.syncAll())
    await converge(page, 3)
    expect(errors).toEqual([])
    expect(page.debugFailures).toEqual([])
    if (process.env.UI_VERBOSE) console.log('JUDGED', seed0, JSON.stringify(judged))
    expect(Object.values(judged).reduce((a, b) => a + b, 0)).toBeGreaterThan(Number(process.env.UI_ROUNDS || 30) / 2)
  })
}
