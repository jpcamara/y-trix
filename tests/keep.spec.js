// Nothing typed is lost and nothing is there twice. Three users type, each
// key a character no one else types, and restructure the document around
// each other (Enter, lists, headings, quotes, code, formatting, nesting,
// attachments, images, line breaks, pasted blocks), with offline spells, on a network that loses, repeats and
// reorders updates. Nobody deletes anything, so at the end every character
// typed has to be in the document exactly once.
// KEEP_SEEDS=1,2,3 KEEP_OPS=150 pick the runs.
import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

for (const seed0 of (process.env.KEEP_SEEDS || '1,2,3').split(',').map(Number)) {
  test(`trix: every character typed is in the document once (seed ${seed0})`, async ({ page }) => {
    test.setTimeout(180000)
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    if (process.env.STRICT) page.on('console', (m) => { if (m.text().includes('did not show what Y holds')) errors.push(m.text()) })
    await open(page)
    await page.evaluate(() => window.ytDemo.addPeer())
    await page.fill('#delay', '15')
    await page.evaluate((s) => { let seed = s + 1; window.ytDemo.chaos = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 } }, seed0)
    let seed = seed0
    const rand = (n) => { seed = (seed * 16807) % 2147483647; return seed % n }
    const typed = []
    // Text the document began with is never typed by anyone, so a write that
    // inserts some of it wrote again what was there. So is an attachment
    // inserted a second time (each one made here is different).
    await page.evaluate(() => {
      window.rewrites = []
      window.ytDemo.peers.forEach((p, i) => {
        const t = p.doc.getText('trix')
        const embeds = () => new Set(t.toDelta().filter((d) => typeof d.insert !== 'string').map((d) => JSON.stringify(d.insert)))
        let had = embeds() // as the document was after the change before this one
        t.observe((ev, tr) => {
          for (const d of ev.delta) {
            if (tr.local && (typeof d.insert === 'string' ? /[A-Za-z.]/.test(d.insert) : d.insert && had.has(JSON.stringify(d.insert)))) window.rewrites.push({ peer: i, during: window.currentOp, delta: JSON.stringify(ev.delta).slice(0, 1500) })
          }
          had = embeds()
        })
      })
    })
    for (let k = 0; k < Number(process.env.KEEP_OPS || 120); k++) {
      const peer = rand(3)
      const len = await page.evaluate((i) => window.ytDemo.peers[i].editor.getDocument().getLength(), peer)
      const at = rand(len)
      await caret(page, peer, at).catch(() => {})
      // (a caret: with something selected, typing replaces it, and that is a deletion)
      if (!(await page.evaluate((i) => { const p = window.ytDemo.peers[i]; const r = p.editor.getSelectedRange(); return document.activeElement === p.element && r && r[0] === r[1] }, peer))) continue
      await page.evaluate((op) => { window.currentOp = op }, k)
      const op = ['type', 'type', 'type', 'type', 'type', 'enter', 'bold', 'italic', 'href', 'heading1', 'quote', 'code', 'bullet', 'number', 'indent', 'outdent', 'attachment', 'offline', 'sync', 'paste', 'linebreak', 'image', 'image'][rand(23)]
      if (op === 'type') {
        const ch = String.fromCharCode(0x4e00 + k)
        await page.keyboard.type(ch)
        if (await page.evaluate(({ i, ch }) => window.ytDemo.peers[i].editor.getDocument().toString().includes(ch), { i: peer, ch })) typed.push(ch)
      } else if (op === 'enter') await page.keyboard.press('Enter')
      else if (op === 'offline') { if (rand(2)) await page.uncheck('#online'); else await page.check('#online') } else if (op === 'sync') await page.evaluate(() => window.ytDemo.syncAll())
      else {
        await page.evaluate(({ i, op, at, n, k }) => {
          const ed = window.ytDemo.peers[i].editor
          const len = ed.getDocument().getLength()
          const toggle = (name) => { if (ed.attributeIsActive(name)) ed.deactivateAttribute(name); else if (ed.canActivateAttribute(name)) ed.activateAttribute(name) }
          if (op === 'bold' || op === 'italic') { ed.setSelectedRange([at, Math.min(len - 1, at + 1 + n)]); toggle(op) } else if (op === 'href') { if (at + 1 + n < len) { ed.setSelectedRange([at, at + 1 + n]); ed.activateAttribute('href', 'https://example.com/' + n) } } else if (op === 'indent') { if (ed.canIncreaseNestingLevel()) ed.increaseNestingLevel() } else if (op === 'outdent') { if (ed.canDecreaseNestingLevel()) ed.decreaseNestingLevel() } else if (op === 'attachment') ed.insertAttachment(new window.Trix.Attachment({ content: '<b>@m' + k + '</b>', contentType: 'mention' }))
          else if (op === 'image') ed.insertAttachment(new window.Trix.Attachment({ url: 'https://example.com/' + k + '.png', contentType: 'image/png', filename: k + '.png', filesize: 100 + k, width: 4, height: 4 }))
          else if (op === 'linebreak') ed.insertLineBreak()
          else if (op === 'paste') ed.insertHTML(['<div>P</div><blockquote>Q</blockquote>', '<ul><li>P</li><li>Q</li></ul>', '<h1>P</h1><pre>Q</pre>', 'P<br>Q', '<div><strong>P</strong><em>Q</em></div>'][n % 5].replace('P', String.fromCharCode(0x6000 + 2 * k)).replace('Q', String.fromCharCode(0x6001 + 2 * k)))
          else toggle(op)
          const end = ed.getSelectedRange()[1]
          ed.setSelectedRange([end, end])
        }, { i: peer, op, at, n: rand(8), k })
        if (op === 'paste') typed.push(String.fromCharCode(0x6000 + 2 * k), String.fromCharCode(0x6001 + 2 * k))
      }
    }
    await page.check('#online')
    await page.evaluate(() => { window.ytDemo.chaos = null })
    await page.waitForTimeout(400)
    await page.evaluate(() => window.ytDemo.syncAll())
    const text = await converge(page, 3, 15000)
    const lost = typed.filter((ch) => !text.includes(ch))
    const twice = typed.filter((ch) => text.split(ch).length > 2)
    if (lost.length + twice.length > 0) console.log('KEEP', JSON.stringify({ lost, twice, text: text.slice(0, 600) }))
    const rewrites = await page.evaluate(() => window.rewrites)
    for (const r of rewrites.slice(0, 3)) console.log('REWRITE', seed0, JSON.stringify(r))
    expect(lost).toEqual([])
    expect(twice).toEqual([])
    // and what the document began with, letter for letter
    expect(text.replace(/[\u4e00-\u9fff\ufffc\s]/g, '')).toBe('Helloworld.Editmeineithereditor.Secondparagraph.')
    expect(rewrites.map((r) => r.during), 'text or an attachment that was in the document was written again').toEqual([])
    expect(typed.length).toBeGreaterThan(10)
    expect(errors).toEqual([])
  })
}
