// Three editors, a wide mix of operations through the keyboard and the
// editor API, offline spells, and undo. Positions are raw UTF-16 offsets, so
// some land inside an emoji. WIDE_SEEDS=1,2,3 WIDE_OPS=160 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

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
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const ops = ['type', 'type', 'enter', 'backspace', 'bold', 'italic', 'href', 'heading1', 'quote', 'code', 'bullet', 'number', 'indent', 'outdent', 'attachment', 'html', 'rangeDelete', 'undo', 'redo', 'offline']
    for (let k = 0; k < Number(process.env.WIDE_OPS || 160); k++) {
      const peer = rand(3)
      const len = await page.evaluate((i) => window.ytDemo.peers[i].editor.getDocument().getLength(), peer)
      const at = rand(len)
      await caret(page, peer, at).catch(() => {})
      const op = ops[rand(ops.length)]
      if (op === 'type') await page.keyboard.type(['x', 'yy ', '\u{1F600}', 'é'][rand(4)])
      else if (op === 'enter') await page.keyboard.press('Enter')
      else if (op === 'backspace') await page.keyboard.press('Backspace')
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
    await page.evaluate(() => window.ytDemo.syncAll())
    await converge(page, 3, 15000)
    expect(errors).toEqual([])
  })
}
