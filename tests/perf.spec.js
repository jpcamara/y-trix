import { test, expect } from '@playwright/test'
import { open, caret, converge } from './helpers.js'

test('trix perf: keystroke sync cost on a 2000-block doc', async ({ page }) => {
  // Trix takes a while to render 2,000 blocks twice on a slow CI machine
  test.setTimeout(120000)
  await open(page)
  const load = await page.evaluate(() => {
    const t = performance.now()
    window.ytDemo.peers[0].editor.loadHTML(Array.from({ length: 2000 }, (_, i) => `<div>Paragraph ${i} with <strong>some</strong> text.</div>`).join(''))
    return Math.round(performance.now() - t)
  })
  await converge(page, 2, 60000)
  await caret(page, 0, 20000)
  await page.evaluate(() => {
    const b = window.ytDemo.peers[1].binding
    let total = 0; let n = 0
    const orig = b.applyRemote.bind(b)
    b.applyRemote = (e) => { const t = performance.now(); orig(e); total += performance.now() - t; n++ }
    window.restoreRemote = () => { b.applyRemote = orig; return n ? total / n : 0 }
  })
  const ms = await page.evaluate(() => {
    const { binding, editor } = window.ytDemo.peers[0]
    let total = 0
    const orig = binding.flushLocal.bind(binding)
    binding.flushLocal = (h) => { const t = performance.now(); orig(h); total += performance.now() - t }
    const t0 = performance.now()
    for (let k = 0; k < 50; k++) editor.insertString('x')
    window.trixInsertMs = (performance.now() - t0) / 50
    binding.flushLocal = orig
    return total / 50
  })
  await converge(page, 2, 60000)
  const remoteMs = await page.evaluate(() => window.restoreRemote())
  console.log('TRIX PERF', JSON.stringify({ load, localFlushMs: ms.toFixed(2), trixLocalInsertMs: (await page.evaluate(() => window.trixInsertMs)).toFixed(2), remoteApplyMs: remoteMs.toFixed(2) }))
  expect(ms).toBeLessThan(5) // the binding's share of a local change
})
