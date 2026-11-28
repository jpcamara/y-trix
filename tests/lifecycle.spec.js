// The editor and the binding coming and going: the element hidden, disabled,
// taken out of the page and put back, the whole document loaded over, the
// binding destroyed and made again, two editors on one Y.Doc.
import { test, expect } from '@playwright/test'
import { open, caret, converge, text } from './helpers.js'

const done = async (page, n = 2) => {
  await page.evaluate(() => window.ytDemo.syncAll())
  return converge(page, n)
}
const debug = () => new URLSearchParams(location.search).has('debug')

test('trix: changes that arrive while the editor is hidden are there when it is shown', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { window.ytDemo.peers[1].element.style.display = 'none' })
  await caret(page, 0, 0)
  await page.keyboard.type('While hidden. ')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  await page.evaluate(() => { window.ytDemo.peers[1].element.style.display = '' })
  expect(await done(page)).toContain('While hidden. \nHello')
  await caret(page, 1, 0)
  await page.keyboard.type('After. ')
  expect(await done(page)).toContain('After. While hidden.')
})

test('trix: a disabled editor shows what the others do', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { window.ytDemo.peers[1].element.disabled = true; window.ytDemo.peers[1].element.setAttribute('contenteditable', 'false') })
  await caret(page, 0, 0)
  await page.keyboard.type('One. ')
  expect(await done(page)).toContain('One. Hello')
  await page.evaluate(() => { window.ytDemo.peers[1].element.disabled = false; window.ytDemo.peers[1].element.setAttribute('contenteditable', 'true') })
  await caret(page, 1, 0)
  await page.keyboard.type('Two. ')
  expect(await done(page)).toContain('Two. One. Hello')
})

test('trix: an editor taken out of the page and put back goes on syncing', async ({ page }) => {
  await open(page)
  await page.evaluate(() => { const el = window.ytDemo.peers[1].element; window.parked = el.parentNode; window.next = el.nextSibling; el.remove() })
  await caret(page, 0, 0)
  await page.keyboard.type('While out. ')
  await page.waitForTimeout(100)
  await page.evaluate(() => { window.parked.insertBefore(window.ytDemo.peers[1].element, window.next) })
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => window.ytDemo.peers[1].element.editor === window.ytDemo.peers[1].editor)).toBe(true)
  expect(await done(page)).toContain('While out. Hello')
  await caret(page, 1, 0)
  await page.keyboard.type('Back. ')
  expect(await done(page)).toContain('Back. While out. Hello')
})

test('trix: loading a whole document over everything while someone else types', async ({ page }) => {
  await open(page)
  // (long enough on the way that none of the typing has arrived when the
  // other user loads: what had arrived is replaced with the rest of the
  // document, and on a slow machine that was the first letter)
  await page.fill('#delay', '600')
  await caret(page, 1, 3)
  await page.keyboard.type('typed ')
  await page.evaluate(() => window.ytDemo.peers[0].editor.loadHTML('<h1>New</h1><ul><li>a</li><li>b</li></ul>'))
  await page.keyboard.type('more')
  await page.waitForTimeout(1500)
  // (the typing lands somewhere in what the other user loaded)
  expect(await done(page)).toContain('typed ')
  await page.fill('#delay', '80')
  await page.evaluate(() => window.ytDemo.peers[1].editor.loadHTML(''))
  await page.waitForTimeout(300)
  expect((await done(page)).trim()).toBe('')
  await caret(page, 0, 0)
  await page.keyboard.type('again')
  await page.waitForTimeout(300)
  expect(await done(page)).toBe('again\n')
  await page.evaluate(() => { const e = window.ytDemo.peers[1].editor; e.loadJSON(JSON.parse(JSON.stringify(e))) })
  await page.waitForTimeout(300)
  expect(await done(page)).toBe('again\n')
  // a form reset loads the field's first value
  await page.evaluate(() => { const el = window.ytDemo.peers[1].element; const form = document.createElement('form'); el.parentNode.insertBefore(form, el); form.appendChild(el.inputElement); form.appendChild(el); })
  await page.waitForTimeout(100)
  await page.evaluate(() => window.ytDemo.peers[1].element.closest('form').reset())
  await page.waitForTimeout(300)
  await done(page)
})

test('trix: a binding destroyed and made again takes up where Y is', async ({ page }) => {
  await open(page)
  await page.evaluate(() => window.ytDemo.peers[1].binding.destroy())
  await caret(page, 0, 0)
  await page.keyboard.type('A while B is unbound. ')
  await caret(page, 1, 0)
  await page.keyboard.type('lost ')
  await page.evaluate((debug) => {
    const p = window.ytDemo.peers[1]
    p.binding = new window.ytDemo.TrixBinding(p.doc.getText('trix'), p.element, p.awareness, { debug })
  }, await page.evaluate(debug))
  const out = await done(page)
  expect(out).toContain('A while B is unbound. Hello')
  expect(out).not.toContain('lost')
  await caret(page, 1, 0)
  await page.keyboard.type('B again. ')
  expect(await done(page)).toContain('B again. A while')
  await page.evaluate(() => window.ytDemo.peers[1].editor.undo())
  expect(await done(page)).not.toContain('B again')
  // and the editor works as it did before any binding once the binding is gone
  await page.evaluate(() => window.ytDemo.peers[1].binding.destroy())
  await caret(page, 1, 0)
  await page.keyboard.type('Own. ')
  await page.evaluate(() => window.ytDemo.peers[1].editor.undo())
  expect(await text(page, 1)).not.toContain('Own')
})

test('trix: two editors bound to one Y.Doc follow each other', async ({ page }) => {
  await open(page)
  await page.evaluate(async (debug) => {
    const p = window.ytDemo.peers[0]
    const wrap = document.createElement('div')
    wrap.innerHTML = '<input type="hidden" id="twin-input"><trix-editor id="twin" input="twin-input"></trix-editor>'
    const element = wrap.querySelector('trix-editor')
    const ready = new Promise((resolve) => element.addEventListener('trix-initialize', resolve, { once: true }))
    document.getElementById('peers').appendChild(wrap)
    await ready
    const binding = new window.ytDemo.TrixBinding(p.doc.getText('trix'), element, null, { debug })
    window.ytDemo.peers.push({ name: 'Twin', id: 'twin', doc: p.doc, awareness: p.awareness, element, editor: element.editor, binding })
  }, await page.evaluate(debug))
  expect(await text(page, 2)).toContain('Hello')
  await caret(page, 2, 0)
  await page.keyboard.type('Twin. ')
  await page.keyboard.press('Enter')
  await caret(page, 0, 9)
  await page.keyboard.type('First. ')
  await caret(page, 1, 'end')
  await page.keyboard.type(' Bob.')
  await page.waitForTimeout(200)
  const out = await converge(page, 3)
  expect(out).toContain('Twin. ')
  expect(out).toContain('First. ')
  expect(out).toContain(' Bob.')
  await page.evaluate(() => { window.ytDemo.peers[2].editor.undo(); window.ytDemo.peers[2].editor.undo() })
  const after = await converge(page, 3)
  expect(after).not.toContain('Twin. ')
  expect(after).toContain('First. ')
})

test('trix: two editors that both start empty and type at once', async ({ page }) => {
  await open(page, '?empty')
  await page.uncheck('#online')
  await caret(page, 0, 0)
  await page.keyboard.type('from A')
  await caret(page, 1, 0)
  await page.keyboard.type('from B')
  await page.check('#online')
  const out = await done(page)
  expect(out).toContain('from A')
  expect(out).toContain('from B')
})

// ---- the options, and binding before the editor is ready ---------------------

const twin = async (page, options, { early = false } = {}) => page.evaluate(async ({ options, early, debug }) => {
  const p = window.ytDemo.peers[0]
  const Y = window.ytDemo.Y
  const wrap = document.createElement('div')
  wrap.innerHTML = '<input type="hidden" id="twin-input"><trix-editor id="twin" input="twin-input"></trix-editor>'
  const element = wrap.querySelector('trix-editor')
  const initialized = new Promise((resolve) => element.addEventListener('trix-initialize', resolve, { once: true }))
  const opts = { debug, ...options }
  if (options.undoManager) opts.undoManager = window.sharedUndo = new Y.UndoManager(p.doc.getText('trix'), { trackedOrigins: new Set(['mine']), captureTimeout: 5000 /* (a slow machine can take more than Yjs's half second over six letters, and they would be two steps) */ })
  let binding
  // early: bound before the element is in the page, so before Trix has set it up
  if (early) binding = new window.ytDemo.TrixBinding(p.doc.getText('trix'), element, p.awareness, opts)
  const before = early ? { attached: binding.attached, undo: binding.undoManager === undefined } : null
  document.getElementById('peers').appendChild(wrap)
  if (!early) { await initialized; binding = new window.ytDemo.TrixBinding(p.doc.getText('trix'), element, p.awareness, opts) }
  const same = (await binding.ready) === binding
  window.ytDemo.peers.push({ name: 'Twin', id: 'twin', doc: p.doc, awareness: p.awareness, element, editor: element.editor, binding })
  return { before, same, attached: binding.attached }
}, { options, early, debug: await page.evaluate(debug) })

test('trix: a binding made before the editor is set up is on it once it is', async ({ page }) => {
  await open(page)
  const r = await twin(page, {}, { early: true })
  expect(r).toEqual({ before: { attached: false, undo: true }, same: true, attached: true })
  expect(await text(page, 2)).toContain('Hello')
  await caret(page, 2, 0)
  await page.keyboard.type('Early. ')
  expect(await converge(page, 3)).toContain('Early. Hello')
})

test('trix: a binding destroyed before the editor is set up never binds', async ({ page }) => {
  await open(page)
  const r = await page.evaluate(async () => {
    const p = window.ytDemo.peers[0]
    const element = document.createElement('trix-editor')
    const binding = new window.ytDemo.TrixBinding(p.doc.getText('trix'), element)
    binding.destroy()
    binding.destroy()
    const initialized = new Promise((resolve) => element.addEventListener('trix-initialize', resolve, { once: true }))
    document.getElementById('peers').appendChild(element)
    await initialized
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { attached: binding.attached, text: element.editor.getDocument().toString() }
  })
  expect(r).toEqual({ attached: false, text: '\n' })
})

test('trix: the form input holds the HTML after other people\'s changes too', async ({ page }) => {
  await open(page)
  await twin(page, {})
  await caret(page, 1, 0)
  await page.keyboard.type('From Bob. ')
  await converge(page, 3)
  // the twin never had the focus: what its form would submit is what everyone sees
  const value = await page.evaluate(() => document.getElementById('twin-input').value)
  expect(value).toContain('From Bob. Hello')
  expect(value).toMatch(/^<div>/)
})

test('trix: undo through an undo manager of the app\'s own', async ({ page }) => {
  await open(page)
  await twin(page, { undoManager: true })
  await caret(page, 2, 0)
  await page.keyboard.type('Mine. ')
  await caret(page, 1, 0)
  await page.keyboard.type('Bob. ')
  await converge(page, 3)
  const r = await page.evaluate(() => {
    const b = window.ytDemo.peers[2].binding
    const same = b.undoManager === window.sharedUndo
    const can = window.ytDemo.peers[2].editor.canUndo()
    window.sharedUndo.undo()
    return { same, can }
  })
  expect(r).toEqual({ same: true, can: true })
  const out = await converge(page, 3)
  expect(out).not.toContain('Mine.')
  expect(out).toContain('Bob. ')
  // destroy leaves the app's undo manager alive, and no longer tracking this binding
  const after = await page.evaluate(() => {
    const b = window.ytDemo.peers[2].binding
    b.destroy()
    return { tracks: window.sharedUndo.trackedOrigins.has(b), still: window.sharedUndo.trackedOrigins.has('mine'), redo: window.sharedUndo.redoStack.length }
  })
  expect(after).toEqual({ tracks: false, still: true, redo: 1 })
})

test('trix: with cursors off the others\' carets are not drawn, and this one is still published', async ({ page }) => {
  await open(page)
  const carets = () => page.evaluate(() => document.querySelectorAll('[data-y-caret]').length)
  await caret(page, 1, 3)
  await page.waitForTimeout(150)
  const before = await carets()
  expect(before).toBeGreaterThan(0)
  // (a second editor on Alice's doc and awareness, drawing nothing)
  await twin(page, { cursors: false })
  await caret(page, 1, 5)
  await page.waitForTimeout(150)
  expect(await carets()).toBe(before)
  await caret(page, 2, 2)
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => !!window.ytDemo.peers[0].awareness.getLocalState().cursor)).toBe(true)
  // the classes to style them by
  expect(await page.evaluate(() => [document.querySelector('.y-trix-cursors') !== null, document.querySelector('.y-trix-caret .y-trix-caret-label') !== null, document.querySelector('.y-trix-caret').style.getPropertyValue('--y-trix-color') !== ''])).toEqual([true, true, true])
})

test('trix: with attachments off a file is refused and an attachment from someone else is not shown', async ({ page }) => {
  await open(page)
  await twin(page, { attachments: false })
  const r = await page.evaluate(async () => {
    const [a, b, t] = window.ytDemo.peers
    // Bob attaches something
    b.element.focus()
    b.editor.setSelectedRange([0, 0])
    b.editor.insertAttachment(new window.Trix.Attachment({ content: '<em>card</em>' }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const shown = { alice: a.editor.getDocument().getAttachments().length, bob: b.editor.getDocument().getAttachments().length, twin: t.editor.getDocument().getAttachments().length }
    const first = t.editor.getDocument().toString()[0]
    const lengths = [a, t].map((p) => p.editor.getDocument().getLength())
    // and the twin is handed a file
    t.editor.setSelectedRange([3, 3])
    t.editor.insertFile(new File(['x'], 'x.txt', { type: 'text/plain' }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { shown, first, lengths, after: t.editor.getDocument().getAttachments().length, inY: a.doc.getText('trix').toDelta().filter((op) => typeof op.insert !== 'string').length }
  })
  expect(r.shown).toEqual({ alice: 1, bob: 1, twin: 0 })
  expect(r.first).toBe('�')
  expect(r.lengths[0]).toBe(r.lengths[1])
  expect(r.after).toBe(0)
  expect(r.inY).toBe(1)
  // and nothing the twin itself does puts an attachment in the shared document:
  // pasted HTML with an image, Trix's own API, a whole document loaded
  const own = await page.evaluate(async () => {
    const [a, , t] = window.ytDemo.peers
    const embeds = () => a.doc.getText('trix').toDelta().filter((op) => typeof op.insert !== 'string').length
    const wait = () => new Promise((resolve) => setTimeout(resolve, 200))
    const before = embeds()
    const out = []
    t.element.focus()
    t.editor.setSelectedRange([2, 2])
    t.editor.insertHTML('<img src="https://example.com/x.png"> pasted ')
    await wait(); out.push(embeds() - before)
    const data = new DataTransfer()
    data.setData('text/html', '<p>from the clipboard <img src="https://example.com/y.png"></p>')
    data.setData('text/plain', 'from the clipboard')
    t.element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await wait(); out.push(embeds() - before)
    t.editor.insertAttachment(new window.Trix.Attachment({ content: '<b>card</b>' }))
    await wait(); out.push(embeds() - before)
    t.editor.insertAttachments([1, 2].map((n) => new window.Trix.Attachment({ url: `https://example.com/${n}.png`, contentType: 'image/png' })))
    await wait(); out.push(embeds() - before)
    return { out, kept: a.doc.getText('trix').toString().includes('pasted'), twin: t.editor.getDocument().getAttachments().length, same: t.editor.getDocument().toString().replace(/\ufffd/g, '\ufffc') === a.editor.getDocument().toString() }
  })
  expect(own).toEqual({ out: [0, 0, 0, 0], kept: true, twin: 0, same: true })
  // typing in the twin lands where it should for everyone
  await page.evaluate(() => { const t = window.ytDemo.peers[2]; t.editor.loadHTML(''); t.editor.insertString('Hello') })
  await page.evaluate(() => { const b = window.ytDemo.peers[1]; b.element.focus(); b.editor.setSelectedRange([0, 0]); b.editor.insertAttachment(new window.Trix.Attachment({ content: '<em>card</em>' })) })
  await page.waitForTimeout(300)
  await caret(page, 2, 1)
  await page.keyboard.type('X')
  await page.waitForTimeout(300)
  const texts = await page.evaluate(() => window.ytDemo.peers.map((p) => p.doc.getText('trix').toString().slice(0, 2)))
  expect(texts[0]).toBe('XH')
})

test('trix: a binding made right after the editor is put in the page, before trix-initialize', async ({ page }) => {
  await open(page)
  const r = await page.evaluate(async (debug) => {
    const p = window.ytDemo.peers[0]
    const element = document.createElement('trix-editor')
    element.id = 'twin'
    let initialized = false
    element.addEventListener('trix-initialize', () => { initialized = true }, { once: true })
    document.getElementById('peers').appendChild(element)
    const binding = new window.ytDemo.TrixBinding(p.doc.getText('trix'), element, null, { debug })
    const at = { initialized, attached: binding.attached }
    await binding.ready
    await new Promise((resolve) => setTimeout(resolve, 200))
    window.ytDemo.peers.push({ name: 'Twin', id: 'twin', doc: p.doc, awareness: p.awareness, element, editor: element.editor, binding })
    return { at, initialized, text: element.editor.getDocument().toString().slice(0, 5) }
  }, await page.evaluate(debug))
  expect(r).toEqual({ at: { initialized: false, attached: true }, initialized: true, text: 'Hello' })
  await caret(page, 2, 0)
  await page.keyboard.type('Now. ')
  expect(await converge(page, 3)).toContain('Now. Hello')
})
