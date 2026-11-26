// Three editors, a wide mix of operations through the keyboard and the
// editor API, offline spells, and undo. Positions are raw UTF-16 offsets, so
// some land inside an emoji. WIDE_SEEDS=1,2,3 WIDE_OPS=160 pick the runs;
// WIDE_CHAOS=1 makes the network lose, repeat, reorder and merge updates.
import { test, expect } from '@playwright/test'
import { open, caret, converge, quiet } from './helpers.js'

for (const seed0 of (process.env.WIDE_SEEDS || '102,105').split(',').map(Number)) {
  test(`trix: wide fuzz with three editors converges (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(120000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    // STRICT=1: the settle check having to redraw is a failure too
    if (process.env.STRICT) page.on('console', (m) => { if (m.text().includes('did not show what Y holds')) errors.push(m.text()) })
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    await page.fill('#delay', '120')
    // WIDE_CHAOS=1: updates late, out of order, twice, lost, or merged (see demo/main.js)
    if (process.env.WIDE_CHAOS) await page.evaluate((s) => { let seed = s + 1; window.ytDemo.chaos = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 } }, seed0)
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const ops = ['type', 'type', 'enter', 'backspace', 'bold', 'italic', 'href', 'heading1', 'quote', 'code', 'bullet', 'number', 'indent', 'outdent', 'attachment', 'html', 'rangeDelete', 'undo', 'redo', 'offline']
    // WIDE_KEYS=1 adds what only the keyboard and the clipboard do
    if (process.env.WIDE_KEYS) ops.push('cut', 'cut', 'paste-event', 'paste-event', 'file-paste', 'drop', 'key-Delete', 'key-Shift+Enter', 'key-Tab', 'key-Shift+Tab', 'word-delete', 'key-ArrowUp', 'key-ArrowDown', 'key-Home', 'key-End', 'all-type', 'key-MOD+b', 'key-MOD+i', 'key-Shift+ArrowDown')
    const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
    const PASTES = ['<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>', '<div>one</div><div>two <em>three</em></div>', 'plain <b>bold</b> <span style="font-size: 18pt;">big</span>', '<blockquote>q</blockquote><h1>t</h1><pre>code\n  more</pre>', '<p>\u{1F600} <a href="https://example.com/p">link</a> <del>gone</del></p>', '<table><tr><td>x</td><td>y</td></tr></table>', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">']
    for (let k = 0; k < Number(process.env.WIDE_OPS || 160); k++) {
      const peer = rand(3)
      const len = await page.evaluate((i) => window.ytDemo.peers[i].editor.getDocument().getLength(), peer)
      const at = rand(len)
      await caret(page, peer, at).catch(() => {})
      const op = ops[rand(ops.length)]
      if (op === 'type') await page.keyboard.type(['x', 'yy ', '\u{1F600}', 'é'][rand(4)])
      else if (op === 'enter') await page.keyboard.press('Enter')
      else if (op === 'backspace') await page.keyboard.press('Backspace')
      else if (op.startsWith('key-')) {
        const focused = () => page.evaluate((i) => document.activeElement === window.ytDemo.peers[i].element, peer)
        // (Tab outside a list leaves the editor, and the next key would press a button on the page)
        if (!op.includes('Tab') || await page.evaluate((i) => { const e = window.ytDemo.peers[i].editor; return e.canIncreaseNestingLevel() || e.canDecreaseNestingLevel() }, peer)) await page.keyboard.press(op.slice(4).replace('MOD', MOD))
        if (rand(2) && await focused()) await page.keyboard.type('k')
      } else if (op === 'word-delete') await page.keyboard.press(`${MOD === 'Meta' ? 'Alt' : 'Control'}+Backspace`)
      else if (op === 'all-type') { if (rand(5) === 0) { await page.keyboard.press(`${MOD}+a`); await page.keyboard.type('All') } } else if (op === 'cut') {
        for (let n = 1 + rand(12); n > 0; n--) await page.keyboard.press('Shift+ArrowRight')
        await page.keyboard.press(`${MOD}+x`)
        await page.waitForTimeout(20)
      } else if (op === 'paste-event' || op === 'drop' || op === 'file-paste') {
        // the browser's own events, with clipboard data, as a real paste or drop sends them
        await page.evaluate(({ i, html, plain, op }) => {
          const el = window.ytDemo.peers[i].element
          const data = new DataTransfer()
          if (op === 'file-paste') data.items.add(new File(['hello'], 'note.txt', { type: 'text/plain' }))
          else {
            if (html !== null) data.setData('text/html', html)
            data.setData('text/plain', plain)
          }
          try {
            if (op === 'drop') {
              const r = el.getBoundingClientRect()
              el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 20 }))
            } else if (op === 'file-paste' || html === null) el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
            // (Trix takes pasted HTML from the beforeinput event)
            else {
              const event = new InputEvent('beforeinput', { inputType: 'insertFromPaste', dataTransfer: data, bubbles: true, cancelable: true })
              // (WebKit does not let a script give the event its data, and Trix throws without it)
              if (event.dataTransfer) el.dispatchEvent(event)
            }
          } catch (e) {}
        }, { i: peer, html: rand(3) === 0 ? null : PASTES[rand(PASTES.length)], plain: ['plain text', 'two\nlines', 'three\n\nparas\nhere', 'https://example.com/pasted'][rand(4)], op })
        await page.waitForTimeout(20)
      }
      else if (op === 'offline') { if (rand(2)) await page.uncheck('#online'); else await page.check('#online') } else {
        await page.evaluate(({ i, op, at, n }) => {
          const ed = window.ytDemo.peers[i].editor
          const len = ed.getDocument().getLength()
          const toggle = (name) => { if (ed.attributeIsActive(name)) ed.deactivateAttribute(name); else if (ed.canActivateAttribute(name)) ed.activateAttribute(name) }
          if (op === 'bold' || op === 'italic') { ed.setSelectedRange([at, Math.min(len - 1, at + n)]); toggle(op) } else if (op === 'href') { ed.setSelectedRange([at, Math.min(len - 1, at + n)]); ed.activateAttribute('href', 'https://example.com/' + n) } else if (op === 'indent') { if (ed.canIncreaseNestingLevel()) ed.increaseNestingLevel() } else if (op === 'outdent') { if (ed.canDecreaseNestingLevel()) ed.decreaseNestingLevel() } else if (op === 'attachment') ed.insertAttachment(new window.Trix.Attachment({ content: '<b>@m' + n + '</b>', contentType: 'mention' }))
          else if (op === 'html') ed.insertHTML(['<ul><li>a</li><li>b</li></ul>', '<blockquote>q<br>r</blockquote>', '<h1>h</h1><div>d</div>', '<pre>c\n d</pre>'][n % 4])
          else if (op === 'rangeDelete') { ed.setSelectedRange([at, Math.min(len - 1, at + 3 + n * 4)]); ed.deleteInDirection('backward') } else if (op === 'undo') ed.undo()
          else if (op === 'redo') ed.redo()
          else toggle(op)
        }, { i: peer, op, at, n: rand(8) })
      }
    }
    await page.check('#online')
    if (process.env.WIDE_CHAOS) { await page.evaluate(() => { window.ytDemo.chaos = null }); await page.waitForTimeout(1200) }
    await page.evaluate(() => window.ytDemo.syncAll())
    await converge(page, 3, 15000)
    expect(errors).toEqual([])
    await quiet(page)
  })
}
