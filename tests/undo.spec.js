// Undo takes back the user's own changes and nobody else's. One user edits
// at random and then undoes everything they did, while two others put in
// numbered words. Every one of those words has to be there afterwards, and
// none of what the first user typed.
// UNDO_SEEDS=1,2,3 UNDO_OPS=60 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

for (const seed0 of (process.env.UNDO_SEEDS || '1,2,3').split(',').map(Number)) {
  test(`trix: undoing everything leaves what the others typed (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(120000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    await page.fill('#delay', '20')
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const theirs = []
    const mine = []
    for (let k = 0; k < Number(process.env.UNDO_OPS || 40); k++) {
      if (rand(3) === 0) {
        // someone else puts a word in, as a remote user's typing arrives: through Y
        const word = `W${1 + rand(2)}n${k}w`
        await page.evaluate(({ word, r }) => {
          const p = window.ytDemo.peers[Number(word[1])]
          const t = p.doc.getText('trix')
          const units = t.toDelta().map((o) => (typeof o.insert === 'string' ? o.insert : '\u0000')).join('')
          let pos = r % Math.max(1, t.length)
          // (not between the halves of an emoji)
          if (pos > 0 && units.charCodeAt(pos) >= 0xdc00 && units.charCodeAt(pos) <= 0xdfff) pos++
          p.doc.transact(() => t.insert(pos, word), 'a peer')
        }, { word, r: rand(100000) })
        theirs.push(word)
        continue
      }
      const len = await page.evaluate(() => window.ytDemo.peers[0].editor.getDocument().getLength())
      const at = rand(len)
      await caret(page, 0, at).catch(() => {})
      const op = ['type', 'type', 'enter', 'backspace', 'bold', 'italic', 'href', 'heading1', 'quote', 'code', 'bullet', 'number', 'indent', 'attachment', 'html', 'range-delete', 'all-delete', 'delete'][rand(18)]
      if (op === 'type') { const word = `M${k}m`; await page.keyboard.type(word); mine.push(word) } else if (op === 'enter') await page.keyboard.press('Enter')
      else if (op === 'backspace') await page.keyboard.press('Backspace')
      else if (op === 'delete') await page.keyboard.press('Delete')
      else {
        await page.evaluate(({ op, at, n }) => {
          const ed = window.ytDemo.peers[0].editor
          const len = ed.getDocument().getLength()
          const toggle = (name) => { if (ed.attributeIsActive(name)) ed.deactivateAttribute(name); else if (ed.canActivateAttribute(name)) ed.activateAttribute(name) }
          if (op === 'bold' || op === 'italic') { ed.setSelectedRange([at, Math.min(len - 1, at + 1 + n)]); toggle(op) } else if (op === 'href') { ed.setSelectedRange([at, Math.min(len - 1, at + 1 + n)]); ed.activateAttribute('href', 'https://example.com/' + n) } else if (op === 'indent') { if (ed.canIncreaseNestingLevel()) ed.increaseNestingLevel() } else if (op === 'attachment') ed.insertAttachment(new window.Trix.Attachment({ content: '<b>@m' + n + '</b>', contentType: 'mention' }))
          else if (op === 'html') ed.insertHTML(['<ul><li>a</li><li>b</li></ul>', '<blockquote>q<br>r</blockquote>', '<h1>h</h1><div>d</div>', '<pre>c\n d</pre>'][n % 4])
          else if (op === 'range-delete') { ed.setSelectedRange([at, Math.min(len - 1, at + 3 + n * 4)]); ed.deleteInDirection('backward') } else if (op === 'all-delete') { if (n === 0) { ed.setSelectedRange([0, len - 1]); ed.deleteInDirection('backward') } } else toggle(op)
        }, { op, at, n: rand(8) })
      }
    }
    await page.waitForTimeout(200)
    const undone = await page.evaluate(() => {
      const ed = window.ytDemo.peers[0].editor
      let n = 0
      while (ed.canUndo() && n < 2000) { ed.undo(); n++ }
      return n
    })
    expect(undone).toBeGreaterThan(0)
    await page.waitForTimeout(200)
    await page.evaluate(() => window.ytDemo.syncAll())
    const text = await converge(page, 3)
    // Every word is still there, its letters in order. (Not always side by
    // side: another word can sit inside it, and so can text the first user
    // deleted there and undo brought back.)
    const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const lost = theirs.filter((w) => !new RegExp(w.split('').map(escape).join('[^]{0,40}?')).test(text))
    const left = mine.filter((w) => text.includes(w))
    if (lost.length + left.length > 0) console.log('UNDO', JSON.stringify({ lost, left, text: text.slice(0, 1500) }))
    expect(lost).toEqual([])
    expect(left).toEqual([])
    expect(errors).toEqual([])
  })
}
