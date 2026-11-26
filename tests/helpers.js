import { expect, test } from '@playwright/test'

export async function open (page, query = '') {
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`[browser ${m.type()}]`, m.text()) })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  // DEBUG_SYNC=1: every binding compares its editor with Y after every step
  page.debugFailures = page.debugFailures || []
  page.on('console', (m) => { if (m.text().startsWith('y-trix debug:')) { page.debugFailures.push(m.text().slice(0, 300)); console.log('DEBUG', m.text().slice(0, 12000)) } })
  if (process.env.DEBUG_SYNC) query += (query.includes('?') ? '&' : '?') + 'debug'
  const version = test.info().project.metadata?.trix
  if (version) query += (query.includes('?') ? '&' : '?') + 'trix=' + version
  await page.goto('/demo/index.html' + query)
  if (version) expect(await page.evaluate(() => window.Trix.VERSION)).toBe(version)
  await page.waitForFunction(() => window.ytDemo && window.ytDemo.peers.length >= 2)
  await page.evaluate(() => window.ytDemo.ready)
  // Trix 2.0 has its classes under Trix.models only; the tests use the 2.1 names
  await page.evaluate(() => { for (const k of ['Document', 'Text', 'Attachment']) if (!window.Trix[k]) window.Trix[k] = window.Trix.models[k] })
}

/**
 * Peer i's document, normalized: blocks with their attributes and the text as
 * runs of equal attributes (how Trix happens to split pieces is not compared).
 * Attachments compare by attributes.
 */
export const docJSON = (page, i) => page.evaluate((i) => {
  const norm = (document) => JSON.stringify(document.getBlocks().map((b) => {
    const runs = []
    for (const p of b.text.getPieces()) {
      const v = p.attachment ? { att: p.attachment.getAttributes() } : p.toString()
      const a = JSON.stringify(p.getAttributes())
      const last = runs[runs.length - 1]
      if (typeof v === 'string' && last && typeof last[0] === 'string' && last[1] === a) last[0] += v
      else runs.push([v, a])
    }
    return [b.attributes, b.htmlAttributes, runs]
  }))
  window.ytNorm = norm
  return norm(window.ytDemo.peers[i].editor.getDocument())
}, i)
export const html = (page, i) => page.evaluate((i) => window.ytDemo.peers[i].element.innerHTML, i)
export const text = (page, i) => page.evaluate((i) => window.ytDemo.peers[i].editor.getDocument().toString(), i)

/** Focus peer i and put the caret at document position pos ('end' allowed). */
export async function caret (page, i, pos) {
  const id = await page.evaluate((i) => window.ytDemo.peers[i].id, i)
  await page.locator('#' + id).focus()
  // Trix finishes focusing asynchronously and may place the caret itself, so
  // set the range until it sticks across a frame.
  await page.evaluate(async ({ i, pos }) => {
    const { editor, element } = window.ytDemo.peers[i]
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    for (let tries = 0; tries < 10; tries++) {
      const len = editor.getDocument().getLength() - 1
      const p = pos === 'end' ? len : Math.min(pos, len)
      editor.setSelectedRange([p, p])
      await frame()
      const r = editor.getSelectedRange()
      if (r && r[0] === p && r[1] === p && element.contains(getSelection().anchorNode)) return
    }
    throw new Error('caret did not stick')
  }, { i, pos })
}

/** Each peer's Trix document equals its Y.Text read back as a document. */
export const consistent = (page) => page.evaluate(() => window.ytDemo.peers.map((p) => {
  const b = p.binding
  const fromY = new window.Trix.Document(b.runsToBlocks(p.doc.getText('trix').toDelta().map((op) =>
    typeof op.insert === 'string' ? { str: op.insert, attrs: op.attributes || {} } : { embed: op.insert, attrs: op.attributes || {} })))
  return window.ytNorm(fromY) === window.ytNorm(p.editor.getDocument()) && (p.doc.getText('trix').length + (b.missingBreak ? 1 : 0) === p.editor.getDocument().getLength() || (p.doc.getText('trix').length === 0 && p.editor.getDocument().isEmpty()))
}))

/** Each peer's DOM is what Trix renders for its document (nothing stale on screen). */
export const rendered = (page) => page.evaluate(() => window.ytDemo.peers.map((p) => {
  // while an attachment is selected, Trix shows its editing controls and holds redraws back
  if (p.editor.composition.editingAttachment) return true
  // Trix leaves the browser's own &nbsp; for a typed space in place, and a <br> for a newline in a code block
  // and drops data-trix-serialized-attributes once an image has loaded
  const strip = (html) => html.replace(/ data-trix-(id|serialized-attributes|store-key)="[^"]*"/g, '').replace(/&nbsp;/g, ' ').replace(/<br>/g, '\n')
  return strip(p.element.innerHTML) === strip(p.element.editorController.compositionController.documentView.constructor.render(p.editor.getDocument()).innerHTML)
}))

export async function converge (page, n = 2, timeout = 5000) {
  await expect.poll(async () => {
    const all = []
    for (let i = 0; i < n; i++) all.push(await docJSON(page, i))
    return all.every((h) => h === all[0])
  }, { timeout }).toBe(true).catch(async (e) => {
    for (let i = 0; i < n; i++) console.log(`peer ${i}:`, await text(page, i), await docJSON(page, i), await page.evaluate((i) => JSON.stringify(window.ytDemo.peers[i].doc.getText('trix').toDelta()), i))
    throw e
  })
  await docJSON(page, 0)
  if ((await consistent(page)).includes(false)) {
    console.log('INCONSISTENT', await page.evaluate(() => window.ytDemo.peers.map((p) => {
      const b = p.binding
      const fromY = new window.Trix.Document(b.runsToBlocks(p.doc.getText('trix').toDelta().map((op) =>
        typeof op.insert === 'string' ? { str: op.insert, attrs: op.attributes || {} } : { embed: op.insert, attrs: op.attributes || {} })))
      const want = window.ytNorm(fromY)
      const have = window.ytNorm(p.editor.getDocument())
      let k = 0
      while (k < want.length && want[k] === have[k]) k++
      return JSON.stringify({ same: want === have, yLen: p.doc.getText('trix').length, missingBreak: !!b.missingBreak, docLen: p.editor.getDocument().getLength(), fromYLen: fromY.getLength(), fromY: want.slice(Math.max(0, k - 160), k + 200), editor: have.slice(Math.max(0, k - 160), k + 200) })
    }).join('\n')))
  }
  expect(await consistent(page)).toEqual(new Array(n).fill(true))
  await expect.poll(() => rendered(page)).toEqual(new Array(n).fill(true)).catch(async (e) => {
    console.log(await page.evaluate(() => window.ytDemo.peers.map((p) => {
      const strip = (html) => html.replace(/ data-trix-(id|serialized-attributes|store-key)="[^"]*"/g, '').replace(/&nbsp;/g, ' ').replace(/<br>/g, '\n')
      const a = strip(p.element.innerHTML); const b = strip(p.element.editorController.compositionController.documentView.constructor.render(p.editor.getDocument()).innerHTML)
      let i = 0; while (i < a.length && a[i] === b[i]) i++
      const c = p.element.editorController
      return 'STATE ' + JSON.stringify({ same: a === b, lenDom: a.length, lenWant: b.length, editingAttachment: !!p.editor.composition.editingAttachment, handlingInput: !!c.handlingInput, composing: !!c.inputController.composing, scheduled: !!c.inputController.scheduledRender, held: p.binding.held, last: p.binding.lastDoc === p.editor.getDocument(), revision: [c.compositionController.revision, p.editor.composition.revision], synced: c.compositionController.documentView.isSynced() }) + '\nDOM  ' + a.slice(Math.max(0, i - 80), i + 200) + '\nWANT ' + b.slice(Math.max(0, i - 80), i + 200)
    }).join('\n')))
    throw e
  })
  expect(page.debugFailures || []).toEqual([])
  // and every editor saves the same HTML for it (what a form would post)
  const saved = await page.evaluate((n) => window.ytDemo.peers.slice(0, n).map((p) => p.element.editorController.compositionController.documentView.constructor.render(p.editor.getDocument()).innerHTML
    // (not compared: a file that is still uploading is marked as such in the editor it was added in only; see Known problems)
    .replace(/ data-trix-(id|serialized-attributes|store-key|serialize)="[^"]*"/g, '').replace(/<progress[^>]*>[^<]*<\/progress>/g, '')), n)
  for (let i = 1; i < n; i++) {
    if (saved[i] !== saved[0]) { let k = 0; while (k < saved[0].length && saved[0][k] === saved[i][k]) k++; console.log('SAVED', JSON.stringify([saved[0].slice(Math.max(0, k - 120), k + 160), saved[i].slice(Math.max(0, k - 120), k + 160)])) }
    expect(saved[i] === saved[0]).toBe(true)
  }
  return text(page, 0)
}
