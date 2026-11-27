// The binding through the real providers: y-websocket against the
// y-websocket 2 server (LevelDB persistence), and y-indexeddb. One editor
// per page, each page in its own browser context.
import { test, expect } from '@playwright/test'
import { caret, docJSON, text, consistent, rendered } from './helpers.js'

const newRoom = () => 'room-' + Date.now() + '-' + Math.random().toString(36).slice(2)

const SERVERS = { '@y/websocket-server 0.1.1 (Yjs 13, LevelDB)': 5185, '@y/websocket-server 0.1.5 (Yjs 14)': 5187 }

async function openPeer (browser, room, peer, extra = '', context) {
  const ctx = context || await browser.newContext()
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) console.log('[browser error]', m.text()) })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`/demo/index.html?mode=yws&room=${room}&peer=${peer}${extra}`)
  await page.waitForFunction(() => window.ytDemo && window.ytDemo.ready)
  await page.evaluate(() => window.ytDemo.ready)
  return page
}

const load = (page, html) => page.evaluate((html) => window.ytDemo.peers[0].editor.loadHTML(html), html)

/** Same document everywhere, each one matching its Y doc and its screen. */
async function converge (pages) {
  let all
  await expect.poll(async () => {
    all = await Promise.all(pages.map((p) => docJSON(p, 0)))
    return all.every((h) => h === all[0])
  }, { timeout: 10000 }).toBe(true).catch((e) => { console.log(all.join('\n---\n')); throw e })
  for (const p of pages) {
    expect(await consistent(p)).toEqual([true])
    await expect.poll(() => rendered(p)).toEqual([true])
  }
  return text(pages[0], 0)
}

for (const [server, port] of Object.entries(SERVERS)) {
  const ws = '&wsport=' + port
  test(`y-websocket, ${server}: two browsers converge and see each other's caret`, async ({ browser }) => {
    const room = newRoom()
    const a = await openPeer(browser, room, 0, ws)
    const b = await openPeer(browser, room, 1, ws)
    await load(a, '<div>Hello world.</div><div>Second paragraph.</div>')
    await expect.poll(() => text(b, 0)).toBe('Hello world.\nSecond paragraph.\n')
    await caret(a, 0, 12)
    await a.keyboard.type(' From A.')
    await caret(b, 0, 'end')
    await b.keyboard.type(' From B.')
    expect(await converge([a, b])).toBe('Hello world. From A.\nSecond paragraph. From B.\n')
    // awareness travels through the provider too
    await expect.poll(() => a.locator('[data-y-trix-overlay] > *').count()).toBeGreaterThan(0)
    await expect.poll(() => b.locator('[data-y-trix-overlay] > *').count()).toBeGreaterThan(0)
    // typing at the same time
    await caret(a, 0, 0)
    await caret(b, 0, 21)
    await Promise.all([a.keyboard.type('aaaa aaaa aaaa ', { delay: 20 }), b.keyboard.type('bbbb bbbb bbbb ', { delay: 20 })])
    expect(await converge([a, b])).toBe('aaaa aaaa aaaa Hello world. From A.\nbbbb bbbb bbbb Second paragraph. From B.\n')
  })

  test(`y-websocket, ${server}: edits made while disconnected merge on reconnect`, async ({ browser }) => {
    const room = newRoom()
    const a = await openPeer(browser, room, 0, ws)
    const b = await openPeer(browser, room, 1, ws)
    await load(a, '<div>Hello world.</div><div>Second paragraph.</div>')
    await a.evaluate(() => window.ytDemo.peers[0].binding.undoManager.clear())
    await expect.poll(() => text(b, 0)).toBe('Hello world.\nSecond paragraph.\n')
    await a.evaluate(() => window.ytDemo.net.setOnline(false))
    await caret(a, 0, 12)
    await a.keyboard.type(' Offline A.')
    await a.evaluate(() => window.ytDemo.peers[0].binding.undoManager.stopCapturing())
    await a.keyboard.press('Enter')
    await a.keyboard.type('New from A')
    await caret(b, 0, 'end')
    await b.keyboard.type(' Online B.')
    await b.waitForTimeout(300)
    expect(await text(b, 0)).not.toContain('Offline A.')
    expect(await text(a, 0)).not.toContain('Online B.')
    await a.evaluate(() => window.ytDemo.net.setOnline(true))
    expect(await converge([a, b])).toBe('Hello world. Offline A.\nNew from A\nSecond paragraph. Online B.\n')
    // undo on A takes back only A's last edit
    // (Enter and the words after it are one step if the keys came within half a second of each other; on a busy machine they are two)
    await a.evaluate(() => { const ed = window.ytDemo.peers[0].editor; ed.undo(); if (ed.getDocument().toString().includes('Offline A.\n\n')) ed.undo() })
    expect(await converge([a, b])).toBe('Hello world. Offline A.\nSecond paragraph. Online B.\n')
  })

  test(`y-websocket, ${server}: a mouse selection, a click and the link dialog in one browser while the other types`, async ({ browser }) => {
    const room = newRoom()
    const a = await openPeer(browser, room, 0, ws)
    const b = await openPeer(browser, room, 1, ws)
    await load(a, '<div>Hello world. Edit me in either editor.</div><div>Second paragraph.</div>')
    await expect.poll(() => text(b, 0)).toBe('Hello world. Edit me in either editor.\nSecond paragraph.\n')
    const point = (offset) => a.evaluate((offset) => {
      const node = window.ytDemo.peers[0].element.querySelector('div').lastChild
      const r = document.createRange()
      r.setStart(node, offset); r.setEnd(node, offset)
      const box = r.getBoundingClientRect()
      return { x: box.left, y: box.top + box.height / 2 }
    }, offset)
    const selected = () => a.evaluate(() => { const ed = window.ytDemo.peers[0].editor; const r = ed.getSelectedRange(); return ed.getDocument().toString().slice(r[0], r[1]) })
    // (A's editor has the focus already: in Firefox the click that gives a Trix editor the focus puts the caret at the start, bound or not)
    await caret(a, 0, 0)
    // A drags over "Edit me" while B types at the start and after "me"
    const from = await point(13)
    const to = await point(20)
    await a.mouse.move(from.x, from.y)
    await a.mouse.down()
    await a.mouse.move((from.x + to.x) / 2, from.y, { steps: 3 })
    await caret(b, 0, 0)
    await b.keyboard.type('One. ')
    await caret(b, 0, (await text(b, 0)).indexOf(' in either'))
    await b.keyboard.type(' too')
    await b.waitForTimeout(300)
    // (not shown in A while its button is down)
    expect(await text(a, 0)).not.toContain('One.')
    await a.mouse.move(to.x, to.y, { steps: 3 })
    await a.mouse.up()
    await expect.poll(() => text(a, 0)).toContain('One. Hello world. Edit me too in either')
    expect(await selected()).toBe('Edit me')
    // A clicks after "Hello" and B types at once; A's key lands where A clicked
    const click = await a.evaluate(() => {
      const ed = window.ytDemo.peers[0].editor
      const rect = ed.getClientRectAtPosition(ed.getDocument().toString().indexOf('Hello') + 5)
      return { x: rect.left + 1, y: rect.top + rect.height / 2 }
    })
    await a.mouse.click(click.x, click.y)
    await caret(b, 0, 0)
    await b.keyboard.type('Zero. ')
    await expect.poll(() => text(a, 0)).toContain('Zero. One.')
    await a.keyboard.type('!')
    await expect.poll(() => text(b, 0)).toContain('Zero. One. Hello! world.')
    // A opens the link dialog on "world", B types before it, A saves
    const at = (await text(a, 0)).indexOf('world')
    await caret(a, 0, at)
    await a.evaluate((at) => window.ytDemo.peers[0].editor.setSelectedRange([at, at + 5]), at)
    const toolbar = '#' + await a.evaluate(() => window.ytDemo.peers[0].element.toolbarElement.id)
    await a.locator(`${toolbar} [data-trix-attribute=href]`).first().click()
    await caret(b, 0, 0)
    await b.keyboard.type('Minus. ')
    await expect.poll(() => text(a, 0)).toContain('Minus. Zero.')
    await a.locator(`${toolbar} input[name=href]`).fill('https://example.com/')
    await a.locator(`${toolbar} input[name=href]`).press('Enter')
    await expect.poll(() => b.evaluate(() => window.ytDemo.peers[0].element.innerHTML)).toContain('<a href="https://example.com/">world</a>')
    for (const p of [a, b]) expect(await p.evaluate(() => JSON.stringify(window.ytDemo.peers[0].doc.getText('trix').toDelta()))).not.toContain('frozen')
    expect(await converge([a, b])).toBe('Minus. Zero. One. Hello! world. Edit me too in either editor.\nSecond paragraph.\n')
  })

  test(`y-websocket, ${server}: a late joiner gets the document from the server`, async ({ browser }) => {
    const room = newRoom()
    const a = await openPeer(browser, room, 0, ws)
    await load(a, '<h1>Title</h1><ul><li>one</li><li>two <strong>bold</strong></li></ul><blockquote>quoted<br>line</blockquote>')
    const want = await docJSON(a, 0)
    const b = await openPeer(browser, room, 1, ws)
    await converge([a, b])
    expect(await docJSON(b, 0)).toBe(want)
    // everyone leaves; the server still has the room
    await a.context().close()
    await b.context().close()
    const c = await openPeer(browser, room, 2, ws)
    await expect.poll(() => docJSON(c, 0)).toBe(want)
    await caret(c, 0, 5)
    await c.keyboard.type(' edited')
    const d = await openPeer(browser, room, 3, ws)
    expect(await converge([c, d])).toContain('Title edited\n')
  })
}

test('y-indexeddb: a reload restores the document and editing goes on', async ({ browser }) => {
  const room = newRoom()
  const ctx = await browser.newContext()
  const a = await openPeer(browser, room, 0, '&persist&nows', ctx)
  await load(a, '<div>Kept across a reload.</div><ol><li>first</li></ol>')
  await caret(a, 0, 21)
  await a.keyboard.type(' Typed.')
  const want = await docJSON(a, 0)
  expect(await text(a, 0)).toBe('Kept across a reload. Typed.\nfirst\n')
  // y-indexeddb writes asynchronously
  await a.waitForTimeout(500)
  await a.reload()
  await a.evaluate(() => window.ytDemo.ready)
  expect(await docJSON(a, 0)).toBe(want)
  // nothing to undo after a reload: the restored doc is not a local edit
  expect(await a.evaluate(() => window.ytDemo.peers[0].editor.canUndo())).toBe(false)
  await caret(a, 0, 28)
  await a.keyboard.type(' More.')
  expect(await converge([a])).toBe('Kept across a reload. Typed. More.\nfirst\n')
  // offline edits stored in IndexedDB reach the server when the network is added
  await a.waitForTimeout(500)
  await a.goto(`/demo/index.html?mode=yws&room=${room}&peer=0&persist&wsport=${SERVERS['@y/websocket-server 0.1.1 (Yjs 13, LevelDB)']}`)
  await a.evaluate(() => window.ytDemo.ready)
  const b = await openPeer(browser, room, 1, '&wsport=' + SERVERS['@y/websocket-server 0.1.1 (Yjs 13, LevelDB)'])
  expect(await converge([a, b])).toBe('Kept across a reload. Typed. More.\nfirst\n')
})
