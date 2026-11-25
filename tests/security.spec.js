// What a peer puts in the Y doc is untrusted. None of it may run script in
// this browser or stop the binding.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

test('trix: hostile and malformed content from a peer does not run and does not stop sync', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss() })
  await open(page)
  const res = await page.evaluate(async () => {
    const { peers } = window.ytDemo
    const b = peers[1]
    window.pwned = []
    const t = b.doc.getText('trix')
    const threw = []
    const attempt = (label, fn) => { try { b.doc.transact(fn, 'a peer') } catch (e) { threw.push(label + ': ' + e.message) } }
    attempt('content attachment', () => t.insertEmbed(0, { attachment: { content: '<img src=x: onerror="pwned.push(\'content onerror\')"><script>pwned.push("content script")</script><a href="javascript:pwned.push(1)">x</a>', contentType: 'mention' } }))
    attempt('image attachment', () => t.insertEmbed(0, { attachment: { url: 'javascript:pwned.push("img url")', href: ' JavaScript:pwned.push("att href")', contentType: 'image/png', filename: 'x.png', width: 10, height: 10 } }))
    attempt('file attachment', () => t.insertEmbed(0, { attachment: { href: 'javascript:pwned.push("file href")', contentType: 'application/pdf', filename: '<img src=x: onerror=pwned.push("filename")>.pdf', filesize: 100 } }, { caption: '<img src=x: onerror=pwned.push("caption")>' }))
    attempt('javascript href', () => t.insert(0, 'click me', { href: 'java\tscript:pwned.push("href")' }))
    attempt('data href', () => t.insert(0, 'click me too', { href: 'data:text/html,<script>top.pwned.push("data")</script>' }))
    attempt('odd text attributes', () => t.insert(0, 'weird', { 'on click': 'x', onclick: 'pwned.push("onclick")', bold: { nested: [1, 2] }, italic: 'yes', unknownAttr: '<script>', href: 7 }))
    attempt('block attribute as a string', () => t.insert(0, '\n', { blockBreak: true, block: 'quote' }))
    attempt('unknown block attributes', () => t.insert(0, '\n', { blockBreak: true, block: ['nope', '<script>', 5, null, { a: 1 }, 'default', 'constructor'] }))
    attempt('block html attributes', () => t.insert(0, '\n', { blockBreak: 'yes', block: ['quote'], html: { onclick: 'pwned.push("html attr")', style: 'position:fixed', 'x y': 'z' } }))
    attempt('block html not an object', () => t.insert(0, '\n', { blockBreak: true, html: 'onclick=1' }))
    attempt('list item without its list', () => t.insert(0, 'orphan\n', { blockBreak: true, block: ['bullet', 'number', 'bulletList', 'heading1', 'code', 'quote', 'bullet'] }))
    attempt('embed without an attachment', () => { t.insertEmbed(0, { attachment: null }); t.insertEmbed(0, { somethingElse: [1, 2, 3] }); t.insertEmbed(0, { attachment: 'str' }); t.insertEmbed(0, 7) })
    attempt('attachment with odd values', () => t.insertEmbed(0, { attachment: { content: { toString: 1 }, contentType: 5, filename: {}, filesize: 'big', width: 'wide', previewable: 'yes', url: {} } }))
    attempt('text after the last break', () => t.insert(t.length, 'tail without break'))
    attempt('only newlines', () => t.insert(0, '\n\n\n'))
    attempt('object replacement character', () => t.insert(0, 'x￼y'))
    attempt('control characters', () => t.insert(0, 'a\u0000b\u0008c d e\r\nf\rg'))
    await new Promise((resolve) => setTimeout(resolve, 800))
    document.querySelectorAll('trix-editor *').forEach((n) => { try { n.click() } catch (e) {} })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const risky = (el) => Array.from(el.querySelectorAll('*')).flatMap((n) => Array.from(n.attributes).filter((x) => /^on/i.test(x.name) || (/script:|^data:text/i.test(x.value.replace(/\s/g, '')) && !/^data-trix-/.test(x.name))).map((x) => `${n.nodeName} ${x.name}=${x.value.slice(0, 80)}`))
    return { threw, pwned: window.pwned, risky: peers.map((p) => risky(p.element)), scripts: document.querySelectorAll('trix-editor script').length, lengths: peers.map((p) => p.doc.getText('trix').length - p.editor.getDocument().getLength()) }
  })
  expect(res.threw).toEqual([])
  expect(res.pwned).toEqual([])
  expect(errors).toEqual([])
  expect(res.risky).toEqual([[], []])
  expect(res.scripts).toBe(0)
  expect(res.lengths).toEqual([0, 0]) // positions still line up with Y
  // editing goes on, on both sides
  await converge(page)
  await caret(page, 0, 'end')
  await page.keyboard.type(' A still types.')
  await caret(page, 1, 0)
  await page.keyboard.type('B too. ')
  const out = await converge(page)
  expect(out).toContain('A still types.')
  expect(out).toContain('B too. ')
  expect(errors).toEqual([])
})
