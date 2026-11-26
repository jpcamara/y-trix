// One odd thing at a time written straight into Y: values of the wrong type,
// names that mean something to JavaScript, characters editors treat
// specially. Every editor has to show the same thing and take typing next
// to it.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
const cases = {
  'text: zero-width no-break space': (t) => t.insert(3, 'a﻿b'),
  'text: carriage return': (t) => t.insert(3, 'a\rb'),
  'text: carriage return and newline': (t) => t.insert(3, 'a\r\nb'),
  'text: carriage returns in a row': (t) => t.insert(3, '\r\r\n\r\n\n\r'),
  'text: newline that ends no block': (t) => t.insert(3, 'a\nb'),
  'text: two spaces': (t) => t.insert(3, '  '),
  'text: tab': (t) => t.insert(3, 'a\tb'),
  'text: no-break spaces': (t) => t.insert(3, '   '),
  'text: zero-width space': (t) => t.insert(3, 'a​b'),
  'text: null character': (t) => t.insert(3, 'a\u0000b'),
  'text: line separator': (t) => t.insert(3, 'a b c'),
  'text: object replacement character': (t) => t.insert(3, 'a￼b'),
  'text: replacement character': (t) => t.insert(3, 'a�b'),
  'text: markup': (t) => t.insert(3, '<b>&amp;</b><!-- x --><script>window.pwned = 1</script>'),
  'text: combining mark': (t) => t.insert(3, 'é'),
  'text: half an emoji': (t) => t.insert(3, '\ud83d'),
  'text: the other half': (t) => t.insert(3, '\ude00'),
  'text: right-to-left': (t) => t.insert(3, '‮abcאב'),
  'format: constructor': (t) => t.format(2, 3, { constructor: true, __proto__: true, toString: true, hasOwnProperty: true }),
  'format: bold of every type': (t) => { t.format(1, 1, { bold: 1 }); t.format(2, 1, { bold: 'yes' }); t.format(3, 1, { bold: {} }); t.format(4, 1, { bold: [] }); t.format(5, 1, { bold: false }); t.format(6, 1, { bold: 0 }) },
  'format: href of every type': (t) => { t.format(1, 1, { href: 1 }); t.format(2, 1, { href: true }); t.format(3, 1, { href: {} }); t.format(4, 1, { href: '' }); t.format(5, 1, { href: ' javascript:alert(1)' }); t.format(6, 1, { href: 'data:text/html,<script>window.pwned = 1</script>' }); t.format(7, 2, { href: 'x" onmouseover="window.pwned = 1' }) },
  'format: block attributes on text': (t) => t.format(2, 3, { blockBreak: true, block: ['quote'], html: { class: 'x' } }),
  'format: unknown': (t) => t.format(2, 3, { blink: true, 'x y': 1, '': true }),
  'format: frozen': (t) => t.format(2, 3, { frozen: true }),
  'line: block a number': (t) => t.insert(3, '\n', { blockBreak: true, block: 7 }),
  'line: block a string': (t) => t.insert(3, '\n', { blockBreak: true, block: 'quote' }),
  'line: block an object': (t) => t.insert(3, '\n', { blockBreak: true, block: { 0: 'quote', length: 1 } }),
  'line: block of junk': (t) => t.insert(3, '\n', { blockBreak: true, block: [7, null, 'quote', [], {}, 'nonsense', 'constructor', '__proto__', 'default', 'quote', 'QUOTE'] }),
  'line: every block at once': (t) => t.insert(3, '\n', { blockBreak: true, block: ['quote', 'heading1', 'code', 'bulletList', 'bullet', 'numberList', 'number', 'attachmentGallery'] }),
  'line: a hundred quotes deep': (t) => t.insert(3, '\n', { blockBreak: true, block: new Array(100).fill('quote') }),
  'line: list item with no list': (t) => t.insert(3, '\n', { blockBreak: true, block: ['bullet'] }),
  'line: list with no item': (t) => t.insert(3, '\n', { blockBreak: true, block: ['bulletList'] }),
  'line: item of the other list': (t) => t.insert(3, '\n', { blockBreak: true, block: ['numberList', 'bullet'] }),
  'line: break that is not true': (t) => { t.insert(3, '\n', { blockBreak: 'yes' }); t.insert(6, '\n', { blockBreak: 1 }); t.insert(9, '\n', { blockBreak: {} }) },
  'line: html of every type': (t) => { t.insert(3, '\n', { blockBreak: true, block: ['code'], html: 'no' }); t.insert(6, '\n', { blockBreak: true, block: ['code'], html: { language: 7, onclick: 'window.pwned = 1', constructor: 'x' } }); t.insert(9, '\n', { blockBreak: true, html: { language: 'js' } }) },
  'line: with text attributes': (t) => t.insert(3, '\n', { blockBreak: true, bold: true, href: 'https://example.com/', strike: 1 }),
  'line: nothing but the end': (t) => { t.delete(0, t.length); t.insert(0, '\n', { blockBreak: true }) },
  'line: a bare newline and nothing else': (t) => { t.delete(0, t.length); t.insert(0, '\n') },
  'line: text and no end': (t) => { t.delete(0, t.length); t.insert(0, 'abc') },
  'line: everything gone': (t) => t.delete(0, t.length),
  'embed: a string': (t) => t.insertEmbed(3, 'str'),
  'embed: true': (t) => t.insertEmbed(3, true),
  'embed: a list': (t) => t.insertEmbed(3, [1]),
  'embed: empty': (t) => t.insertEmbed(3, {}),
  'embed: attachment a number': (t) => t.insertEmbed(3, { attachment: 7 }),
  'embed: attachment a list': (t) => t.insertEmbed(3, { attachment: [1] }),
  'embed: attachment empty': (t) => t.insertEmbed(3, { attachment: {} }),
  'embed: attachment of junk': (t) => t.insertEmbed(3, { attachment: { url: 7, href: {}, contentType: null, filename: ['a'], filesize: 'big', width: 'wide', height: -1, content: 7, previewable: 'yes', constructor: 'x', __proto__: { y: 1 } } }),
  'embed: script url': (t) => t.insertEmbed(3, { attachment: { url: 'javascript:window.pwned = 1', href: 'javascript:window.pwned = 1', contentType: 'image/png', filename: 'a.png' } }),
  'embed: content with script': (t) => t.insertEmbed(3, { attachment: { content: '<img src=x onerror="window.pwned = 1"><script>window.pwned = 1</script><a href="javascript:window.pwned = 1">x</a>', contentType: 'x' } }),
  'embed: image': (t) => t.insertEmbed(3, { attachment: { url: GIF, contentType: 'image/gif', filename: 'a.gif', filesize: 35, width: 1, height: 1 } }),
  'embed: image with a caption and a link': (t) => t.insertEmbed(3, { attachment: { url: GIF, contentType: 'image/gif', filename: 'a.gif' } }, { caption: 'cap', href: 'https://example.com/', bold: true, presentation: 'gallery' }),
  'embed: with block attributes': (t) => t.insertEmbed(3, { attachment: { content: '<b>@m</b>', contentType: 'mention' } }, { blockBreak: true, block: ['quote'] }),
  'embed: the same object twice': (t) => { const e = { attachment: { content: '<b>@m</b>', contentType: 'mention' } }; t.insertEmbed(3, e); t.insertEmbed(3, e) },
  'embed: at the very end': (t) => t.insertEmbed(t.length, { attachment: { content: '<b>@m</b>', contentType: 'mention' } }),
  'embed: a whole gallery': (t) => { for (let i = 0; i < 5; i++) t.insertEmbed(3, { attachment: { url: GIF, contentType: 'image/gif', filename: i + '.gif' } }, { presentation: 'gallery' }) }
}

for (const [name, write] of Object.entries(cases)) {
  test(`trix: odd content in Y, ${name}`, async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    if (process.env.STRICT) page.on('console', (m) => { if (m.text().includes('did not show what Y holds')) errors.push(m.text()) })
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    await page.evaluate((src) => {
      const p = window.ytDemo.peers[1]
      // eslint-disable-next-line no-eval
      p.doc.transact(() => (0, eval)('(' + src + ')')(p.doc.getText('trix')), 'a peer')
    }, write.toString().replace(/\bGIF\b/g, JSON.stringify(GIF)))
    await page.waitForTimeout(350)
    await converge(page, 3)
    for (const at of [4, 'end', 0]) {
      await caret(page, 0, at).catch(() => {})
      await page.keyboard.type('Q')
      await page.keyboard.press('Enter')
      await page.keyboard.type('R')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Backspace')
    }
    await page.waitForTimeout(350)
    await page.evaluate(() => window.ytDemo.syncAll())
    await converge(page, 3)
    expect(await page.evaluate(() => { const all = window.ytDemo.peers.map((p) => JSON.stringify(p.doc.getText('trix').toDelta())); return all.every((d) => d === all[0]) })).toBe(true)
    expect(await page.evaluate(() => window.pwned)).toBeUndefined()
    expect(errors).toEqual([])
  })
}
