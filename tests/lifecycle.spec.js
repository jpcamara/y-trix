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
  await page.fill('#delay', '80')
  await caret(page, 1, 3)
  await page.keyboard.type('typed ')
  await page.evaluate(() => window.ytDemo.peers[0].editor.loadHTML('<h1>New</h1><ul><li>a</li><li>b</li></ul>'))
  await page.keyboard.type('more')
  await page.waitForTimeout(300)
  // (the typing lands somewhere in what the other user loaded)
  expect(await done(page)).toContain('typed ')
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
