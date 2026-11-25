// The binding through the real providers: y-websocket against the
// y-websocket 2 server (LevelDB persistence), and y-indexeddb. One editor
// per page, each page in its own browser context.
import { test, expect } from '@playwright/test'
import { caret, docJSON, text, consistent, rendered } from './helpers.js'

const newRoom = () => 'room-' + Date.now() + '-' + Math.random().toString(36).slice(2)

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

test('y-websocket: two browsers converge and see each other\'s caret', async ({ browser }) => {
  const room = newRoom()
  const a = await openPeer(browser, room, 0)
  const b = await openPeer(browser, room, 1)
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

test('y-websocket: edits made while disconnected merge on reconnect', async ({ browser }) => {
  const room = newRoom()
  const a = await openPeer(browser, room, 0)
  const b = await openPeer(browser, room, 1)
  await load(a, '<div>Hello world.</div><div>Second paragraph.</div>')
  await a.evaluate(() => window.ytDemo.peers[0].binding.undoManager.clear())
  await expect.poll(() => text(b, 0)).toBe('Hello world.\nSecond paragraph.\n')
  await a.evaluate(() => window.ytDemo.net.setOnline(false))
  await caret(a, 0, 12)
  await a.keyboard.type(' Offline A.')
  await a.evaluate(() => window.ytDemo.peers[0].binding.undoManager.stopCapturing())
  await a.keyboard.press('Enter')
  // Trix itself misplaces a key that arrives within a frame of Enter
  await a.waitForTimeout(100)
  await a.keyboard.type('New from A')
  await caret(b, 0, 'end')
  await b.keyboard.type(' Online B.')
  await b.waitForTimeout(300)
  expect(await text(b, 0)).not.toContain('Offline A.')
  expect(await text(a, 0)).not.toContain('Online B.')
  await a.evaluate(() => window.ytDemo.net.setOnline(true))
  expect(await converge([a, b])).toBe('Hello world. Offline A.\nNew from A\nSecond paragraph. Online B.\n')
  // undo on A takes back only A's last edit
  await a.evaluate(() => window.ytDemo.peers[0].editor.undo())
  expect(await converge([a, b])).toBe('Hello world. Offline A.\nSecond paragraph. Online B.\n')
})

test('y-websocket: a late joiner gets the document from the server', async ({ browser }) => {
  const room = newRoom()
  const a = await openPeer(browser, room, 0)
  await load(a, '<h1>Title</h1><ul><li>one</li><li>two <strong>bold</strong></li></ul><blockquote>quoted<br>line</blockquote>')
  const want = await docJSON(a, 0)
  const b = await openPeer(browser, room, 1)
  await converge([a, b])
  expect(await docJSON(b, 0)).toBe(want)
  // everyone leaves; the server still has the room
  await a.context().close()
  await b.context().close()
  const c = await openPeer(browser, room, 2)
  await expect.poll(() => docJSON(c, 0)).toBe(want)
  await caret(c, 0, 5)
  await c.keyboard.type(' edited')
  const d = await openPeer(browser, room, 3)
  expect(await converge([c, d])).toContain('Title edited\n')
})

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
  await a.goto(`/demo/index.html?mode=yws&room=${room}&peer=0&persist`)
  await a.evaluate(() => window.ytDemo.ready)
  const b = await openPeer(browser, room, 1)
  expect(await converge([a, b])).toBe('Kept across a reload. Typed. More.\nfirst\n')
})
