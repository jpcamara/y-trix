// Writes documents as the shared Y.Text holds them next to the HTML Trix
// saves for them, for anything that renders the format somewhere else to be
// checked against (yrby's Y::Trix is). Runs only when asked:
//
//   FIXTURES_OUT=/path/to/trix.json npx playwright test fixtures --project=chromium
import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { open, converge } from './helpers.js'

const written = {
  empty: '',
  'a paragraph': '<div>Hello world.</div>',
  'two paragraphs': '<div>One</div><div>Two</div>',
  'inline formats': '<div>plain <strong>bold</strong> <em>italic</em> <del>strike</del> <strong><em>both</em></strong> <em><strong>other order</strong></em> <del><strong><em>all three</em></strong></del> end</div>',
  links: '<div><a href="https://example.com/a?b=1&amp;c=2">link</a> and <a href="https://example.com/"><strong>bold link</strong> then plain</a> <strong><a href="mailto:a@example.com">mail</a></strong></div>',
  'line breaks': '<div>one<br>two<br><br>four</div><div><br></div><div>after an empty block</div>',
  spaces: '<div> lead</div><div>trail </div><div>a  b   c    d</div><div>   </div><div>tab\there</div>',
  'characters to escape': '<div>&lt;b&gt; &amp; "quotes" \'single\' &nbsp;  nbsp 😀 中文</div>',
  heading: '<h1>Title</h1><div>text</div><h1>Another <em>one</em></h1>',
  quote: '<blockquote>quoted<br>second line</blockquote><div>after</div><blockquote>one</blockquote><blockquote>two</blockquote>',
  code: '<pre>const a = 1\n  if (a) {\n    b()\n  }</pre><div>after</div><pre>&lt;tag&gt; &amp; more</pre>',
  'bullet list': '<ul><li>one</li><li>two <strong>bold</strong></li><li>three</li></ul><div>after</div>',
  'numbered list': '<ol><li>one</li><li>two</li></ol><ul><li>then bullets</li></ul>',
  'nested lists': '<ul><li>one<ul><li>one.one</li><li>one.two<ol><li>deep</li></ol></li></ul></li><li>two</li></ul>',
  'a list in a quote': '<blockquote><ul><li>a</li><li>b</li></ul></blockquote><blockquote><h1>heading in a quote</h1></blockquote>',
  'a quote in a list': '<ul><li><blockquote>quoted item</blockquote></li><li>plain item</li></ul>',
  'code in a list': '<ul><li><pre>code item</pre></li></ul>',
  'everything in a row': '<h1>T</h1><blockquote>q</blockquote><pre>c</pre><ul><li>b</li></ul><ol><li>n</li></ol><div>d</div>',
  'right to left': '<div>\u05e9\u05dc\u05d5\u05dd hello</div><div>hello \u05e9\u05dc\u05d5\u05dd</div><blockquote>\u0645\u0631\u062d\u0628\u0627</blockquote><blockquote>next</blockquote><ul><li>\u05d0</li><li>b</li><li>\u05d2</li></ul><h1>123 \u0645\u0631\u062d\u0628\u0627</h1><div>\u05e9<br></div>',
  'a break at the end of a block': '<div>one<br><br></div><blockquote>q<br><br></blockquote><ul><li>item<br><br></li></ul><div><strong>b<br></strong></div>',
  'empty blocks of every kind': '<h1><br></h1><blockquote><br></blockquote><pre>\n</pre><ul><li><br></li><li><br></li></ul><ol><li><br></li></ol>',
  'lists side by side': '<ul><li>a</li></ul><ol><li>b</li></ol><ul><li>c</li></ul><ul><li>d<ol><li>e</li></ol><ul><li>f</li></ul></li></ul>',
  'spaces around formats': '<div><strong>bold </strong> plain <em> italic</em>  <del>  two  </del> <a href="https://example.com/"> link </a> end </div><div>a <br> b</div>',
  'code with odd text': '<pre>  indented\n\ttab\n\n\nblank lines  \n&lt;b&gt;</pre><pre>one</pre><pre>two</pre>',
  'formats across a break': '<div><strong>bold<br>still bold</strong> <a href="https://example.com/">link<br>still link</a></div>'
}

const generate = (seed0) => {
  let seed = seed0 * 7919 + 13
  const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
  const pick = (a) => a[rand(a.length)]
  const words = ['alpha', 'beta ', ' gamma', 'e', '&amp;', ' ', '  ', '中', '😀', 'x&lt;y', 'a longer run', '.', '"q"', '\u05e9\u05dc\u05d5\u05dd', '   ', '\u00a0']
  const text = () => { let s = ''; for (let i = rand(3) + 1; i > 0; i--) s += pick(words); return s }
  const inline = (depth) => {
    const kind = rand(depth > 1 ? 3 : 9)
    if (kind < 3) return text()
    if (kind === 3) return '<br>'
    if (kind === 4) return `<a href="${pick(['https://example.com/', 'https://example.com/a?b=1&amp;c=2', 'mailto:a@example.com'])}">${inlines(depth + 1)}</a>`
    return `<${pick(['strong', 'em', 'del'])}>${inlines(depth + 1)}</${0}>`.replace(/<(\w+)>(.*)<\/0>$/s, '<$1>$2</$1>')
  }
  const inlines = (depth) => { let s = ''; for (let i = rand(3) + 1; i > 0; i--) s += inline(depth); return s }
  const list = (depth) => {
    const tag = pick(['ul', 'ol'])
    let s = `<${tag}>`
    for (let i = rand(3) + 1; i > 0; i--) s += `<li>${inlines(1)}${depth < 2 && rand(3) === 0 ? list(depth + 1) : ''}</li>`
    return s + `</${tag}>`
  }
  const block = (depth) => {
    const kind = rand(10)
    if (kind < 4) return `<div>${rand(8) === 0 ? '<br>' : inlines(0)}</div>`
    if (kind === 4) return `<h1>${inlines(0)}</h1>`
    if (kind === 5) return `<pre>${text()}\n${text()}</pre>`
    if (kind < 8) return list(depth)
    return `<blockquote>${depth < 1 && rand(2) === 0 ? block(depth + 1) : inlines(0)}</blockquote>`
  }
  let out = ''
  for (let i = rand(5) + 1; i > 0; i--) out += block(0)
  return out
}

test('fixtures: documents in Y next to the HTML Trix saves', async ({ page }) => {
  test.skip(!process.env.FIXTURES_OUT, 'set FIXTURES_OUT to write them')
  test.setTimeout(600000)
  await open(page)
  const cases = Object.entries(written)
  for (let seed = 1; seed <= Number(process.env.FIXTURES_RANDOM || 250); seed++) cases.push([`generated ${seed}`, generate(seed)])
  const out = []
  const record = async (name) => {
    await converge(page)
    await page.waitForTimeout(60)
    const r = await page.evaluate(() => {
      const [a, b] = window.ytDemo.peers
      const Y = window.ytDemo.Y
      // (a new doc with only this document in it: the editors' doc carries every case before it)
      const fresh = new Y.Doc()
      fresh.getText('trix').applyDelta(b.doc.getText('trix').toDelta())
      const bytes = Y.encodeStateAsUpdate(fresh)
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return { saved: [a.element.value, b.element.value], delta: b.doc.getText('trix').toDelta(), update: btoa(binary) }
    })
    // the editor that loaded it and the one that drew it from Y save the same
    expect(r.saved[1], name).toBe(r.saved[0])
    out.push({ name, update: r.update, html: r.saved[0] })
  }
  for (const [name, html] of cases) {
    await page.evaluate((html) => { const ed = window.ytDemo.peers[0].editor; ed.loadHTML(html) }, html)
    await record(name)
  }
  // attachments, made through Trix's own API
  const attach = async (name, make) => {
    await page.evaluate((make) => {
      const ed = window.ytDemo.peers[0].editor
      ed.loadHTML('<div>before  after</div>')
      ed.setSelectedRange([7, 7])
      // eslint-disable-next-line no-eval
      ed.insertAttachment(new window.Trix.Attachment((0, eval)('(' + make + ')')))
    }, make)
    await record(name)
  }
  await attach('an image', '{ url: "https://example.com/a.png", href: "https://example.com/a.png", contentType: "image/png", filename: "a.png", filesize: 12345, width: 300, height: 200 }')
  await attach('an image with a caption', '{ url: "https://example.com/a.png", contentType: "image/png", filename: "a <b>.png", filesize: 2048, width: 30, height: 20 }')
  await page.evaluate(() => { const ed = window.ytDemo.peers[0].editor; const range = ed.getDocument().getRangeOfAttachment(ed.getDocument().getAttachments()[0]); ed.setSelectedRange(range); ed.composition.updateAttributesForAttachment({ caption: 'A "caption" & more' }, ed.getDocument().getAttachments()[0]) })
  await record('an image with a caption set')
  await attach('a file', '{ url: "https://example.com/report.pdf", href: "https://example.com/report.pdf", contentType: "application/pdf", filename: "report.pdf", filesize: 3145728 }')
  await attach('a file with no size', '{ url: "https://example.com/x.zip", contentType: "application/zip", filename: "x.zip" }')
  await attach('content', '{ content: "<em>a card</em> &amp; <strong>more</strong>" }')
  await attach('content with a type', '{ content: "<span>mention</span>", contentType: "application/vnd.example.mention" }')
  await page.evaluate(() => {
    const ed = window.ytDemo.peers[0].editor
    ed.loadHTML('<div>two images</div>')
    ed.setSelectedRange([10, 10])
    ed.insertAttachments([1, 2, 3].map((n) => new window.Trix.Attachment({ url: `https://example.com/${n}.png`, contentType: 'image/png', filename: `${n}.png`, filesize: n * 1000, width: 10, height: 10 })))
  })
  await record('a gallery')
  await attach('an image with alt text and no name', '{ url: "https://example.com/a.jpg", contentType: "image/jpeg", alt: "A <cat> & dog", width: 5, height: 6 }')
  await attach('content with a link of its own', '{ content: "<a href=\\"https://example.com/in\\">inner</a>", href: "https://example.com/outer" }')
  await attach('a file kept from previewing', '{ url: "https://example.com/a.png", contentType: "image/png", filename: "a.png", previewable: false }')
  await attach('sizes', '{ url: "https://example.com/a.bin", contentType: "application/octet-stream", filename: "A.BIN", filesize: 1 }')
  await attach('sizes, zero', '{ url: "https://example.com/a.bin", contentType: "application/octet-stream", filename: "noext", filesize: 0 }')
  await attach('sizes, big', '{ url: "https://example.com/a.bin", contentType: "application/octet-stream", filename: "a.tar.gz", filesize: 1234567890123 }')
  // shapes no Trix command makes, written straight into Y: the binding shows them, and so does a renderer
  const shape = async (name, lines) => {
    await page.evaluate((lines) => {
      const p = window.ytDemo.peers[1]
      const t = p.doc.getText('trix')
      p.doc.transact(() => {
        t.delete(0, t.length)
        for (const [text, attrs, block, html] of lines) {
          if (text !== '') t.insert(t.length, text, attrs || {})
          t.insert(t.length, '\n', { blockBreak: true, ...(block ? { block } : {}), ...(html ? { html } : {}) })
        }
      }, 'a peer')
    }, lines)
    await record(name)
  }
  await shape('an item with no list', [['a', null, ['bullet']], ['b', null, ['number']], ['c', null, ['bullet']]])
  await shape('a list with no item', [['a', null, ['bulletList']], ['b', null, ['bulletList']], ['c', null, ['numberList']]])
  await shape('quotes in quotes', [['a', null, ['quote', 'quote']], ['b', null, ['quote']], ['c', null, ['quote', 'quote', 'quote']]])
  await shape('a heading in a list in a quote', [['a', null, ['quote', 'bulletList', 'bullet', 'heading1']], ['b', null, ['quote', 'bulletList', 'bullet']], ['c', null, ['quote', 'numberList', 'number']]])
  await shape('code inside and outside', [['a\n b', null, ['code', 'quote']], ['c  d', null, ['quote', 'code']], ['e', { bold: true }, ['code']]])
  await shape('code with a language', [['x = 1', null, ['code'], { language: 'ruby', onclick: 'x' }], ['y', null, ['quote'], { language: 'ruby' }]])
  await shape('unknown names', [['a', { bold: true, underline: true, color: 'red', href: 'https://example.com/' }, ['quote', 'nonsense', 'bullet']], ['b', { href: 7, italic: 'yes', strike: true }, 'quote']])
  await shape('deep lists', [['a', null, ['bulletList', 'bullet']], ['b', null, ['bulletList', 'bullet', 'bulletList', 'bullet']], ['c', null, ['bulletList', 'bullet', 'numberList', 'number']], ['d', null, ['bulletList', 'bullet', 'bulletList', 'bullet', 'bulletList', 'bullet']], ['e', null, ['numberList', 'number']]])
  await shape('a link over several formats and a break', [['a', { href: 'https://example.com/' }], ['b', { href: 'https://example.com/', bold: true }, null], ['c\nd', { href: 'https://example.com/2' }, ['quote']]])
  writeFileSync(process.env.FIXTURES_OUT, JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{') + '\n')
  console.log(`wrote ${out.length} documents to ${process.env.FIXTURES_OUT}`)
})
