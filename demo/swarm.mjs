// AGENTS separate browsers (the engines in ENGINES, in turn), one Trix editor
// each, synced through the y-websocket server. Each agent edits at random
// through the keyboard and the editor API for SECONDS, going offline now and
// then. Then all reconnect and we check that every editor, and a late joiner,
// hold the same document, that each matches its own Y doc, and that each
// screen shows it.
//
//   npm run build:demo
//   node demo/server.js &
//   PORT=5185 node node_modules/y-websocket-server-13/src/server.js &
//   ROUNDS=5 SECONDS=30 node demo/swarm.mjs
//
// UNDO=0 leaves out undo/redo.
import * as playwright from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { caret, docJSON, consistent, rendered } from '../tests/helpers.js'

const AGENTS = Number(process.env.AGENTS || 4)
const SECONDS = Number(process.env.SECONDS || 30)
const ROUNDS = Number(process.env.ROUNDS || 3)
const UNDO = process.env.UNDO !== '0'
const SEED = Number(process.env.SEED || Date.now() % 100000)
const ENGINES = (process.env.ENGINES || 'chromium,webkit,firefox').split(',')
const BASE = 'http://localhost:5175/demo/index.html'
mkdirSync('demo/out', { recursive: true })

const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const WORDS = 'alpha beta gamma delta launch ship plan team editor sync merge cursor list quick brown fox jumps lazy dog'.split(' ')

// macOS 27 denies Firefox its app-data folder; see playwright.config.js
const firefoxHome = join(tmpdir(), 'playwright-firefox-home')
mkdirSync(firefoxHome, { recursive: true })
const launch = (engine) => playwright[engine].launch(engine === 'firefox' && process.platform === 'darwin'
  ? { env: { ...process.env, CFFIXED_USER_HOME: firefoxHome } }
  : {})

async function openPeer (browser, room, i) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(e.message))
  await page.goto(`${BASE}?mode=yws&room=${room}&peer=${i}`)
  await page.waitForFunction(() => window.ytDemo && window.ytDemo.ready)
  await page.evaluate(() => window.ytDemo.ready)
  return page
}

const editor = (page, fn, arg) => page.evaluate(({ fn, arg }) => {
  const ed = window.ytDemo.peers[0].editor
  return new Function('ed', 'arg', fn)(ed, arg) // eslint-disable-line no-new-func
}, { fn, arg })
const length = (page) => editor(page, 'return ed.getDocument().getLength()')

async function agent (page, i, until) {
  const R = rng(SEED * 31 + i * 7919)
  const pick = (xs) => xs[Math.floor(R() * xs.length)]
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
  const stats = { ops: 0, failed: 0, offline: 0, kinds: {} }
  const place = async () => caret(page, 0, Math.floor(R() * await length(page)))
  const select = async (n) => {
    const len = await length(page)
    const at = Math.floor(R() * len)
    await caret(page, 0, at)
    await editor(page, 'ed.setSelectedRange(arg)', [at, Math.min(len - 1, at + n)])
  }
  const toggle = (name) => editor(page, 'if (ed.attributeIsActive(arg)) ed.deactivateAttribute(arg); else if (ed.canActivateAttribute(arg)) ed.activateAttribute(arg)', name)
  const actions = [
    [30, 'type', async () => { await place(); await page.keyboard.type(' ' + words(1 + Math.floor(R() * 4)), { delay: 15 + R() * 40 }) }],
    [10, 'delete', async () => { await select(1 + Math.floor(R() * 10)); await page.keyboard.press('Backspace') }],
    [6, 'backspace', async () => { await place(); await page.keyboard.press('Backspace') }],
    [10, 'enter', async () => { await place(); await page.keyboard.press('Enter'); await page.waitForTimeout(80); await page.keyboard.type(words(2), { delay: 20 }) }],
    [12, 'inline', async () => { await select(2 + Math.floor(R() * 10)); await toggle(pick(['bold', 'italic', 'strike'])) }],
    [4, 'link', async () => { await select(3 + Math.floor(R() * 6)); await editor(page, 'ed.activateAttribute("href", arg)', 'https://example.com/' + pick(WORDS)) }],
    [10, 'block', async () => { await place(); await toggle(pick(['heading1', 'quote', 'code', 'bullet', 'number'])) }],
    [4, 'indent', async () => { await place(); await editor(page, pick(['if (ed.canIncreaseNestingLevel()) ed.increaseNestingLevel()', 'if (ed.canDecreaseNestingLevel()) ed.decreaseNestingLevel()'])) }],
    [3, 'attachment', async () => { await place(); await editor(page, 'ed.insertAttachment(new window.Trix.Attachment({ content: "<span class=\\"mention\\">@" + arg + "</span>", contentType: "mention" }))', pick(WORDS)) }],
    [3, 'paste', async () => { await place(); await editor(page, 'ed.insertHTML(arg)', pick(['<strong>pasted</strong> text', '<ul><li>one</li><li>two</li></ul>', '<blockquote>quoted</blockquote>', '🚀 €'])) }],
    ...(UNDO ? [[5, 'undo', async () => { await editor(page, 'ed.undo()'); if (R() < 0.5) await editor(page, 'ed.redo()') }]] : []),
    [3, 'offline', async () => {
      stats.offline++
      await page.evaluate(() => window.ytDemo.net.setOnline(false))
      const back = Date.now() + 1500 + R() * 3000
      while (Date.now() < back && Date.now() < until) { await place(); await page.keyboard.type(' offline ' + words(1), { delay: 25 }) }
      await page.evaluate(() => window.ytDemo.net.setOnline(true))
    }]
  ]
  const total = actions.reduce((s, [w]) => s + w, 0)
  while (Date.now() < until) {
    let x = R() * total
    const [, kind, run] = actions.find(([w]) => (x -= w) < 0) || actions[0]
    try { await run(); stats.ops++; stats.kinds[kind] = (stats.kinds[kind] || 0) + 1 } catch (e) { stats.failed++; stats.lastError = String(e.message).split('\n')[0] }
    await page.waitForTimeout(R() * 150)
  }
  return stats
}

const snapshot = async (page) => ({ doc: await docJSON(page, 0), y: await page.evaluate(() => JSON.stringify(window.ytDemo.peers[0].doc.getText('trix').toDelta())), matchesY: (await consistent(page))[0], rendered: (await rendered(page))[0] })

const engines = Array.from({ length: AGENTS + 1 }, (_, i) => ENGINES[i % ENGINES.length])
const browsers = await Promise.all(engines.map(launch))
const results = []
console.log(`${AGENTS} browsers (${engines.slice(0, AGENTS).join(', ')}), ${ROUNDS} rounds x ${SECONDS}s, undo ${UNDO ? 'on' : 'off'}, seed ${SEED}`)
for (let round = 1; round <= ROUNDS; round++) {
  const room = `swarm-${SEED}-${round}-${Date.now()}`
  const pages = []
  for (let i = 0; i < AGENTS; i++) pages.push(await openPeer(browsers[i], room, i))
  await pages[0].evaluate(() => { const p = window.ytDemo.peers[0]; p.editor.loadHTML('<h1>Swarm</h1><div>Four agents edit this document at once.</div><div>Second paragraph with some words.</div>'); p.binding.undoManager.clear() })
  await pages[0].waitForTimeout(500)

  const until = Date.now() + SECONDS * 1000
  const stats = await Promise.all(pages.map((p, i) => agent(p, i + round * 100, until)))
  await Promise.all(pages.map((p) => p.evaluate(() => window.ytDemo.net.setOnline(true))))

  const started = Date.now()
  let snaps
  let same = false
  while (Date.now() - started < 15000) {
    snaps = await Promise.all(pages.map(snapshot))
    same = snaps.every((s) => s.doc === snaps[0].doc && s.matchesY && s.rendered)
    if (same) break
    await pages[0].waitForTimeout(200)
  }
  const settleMs = Date.now() - started
  const late = await openPeer(browsers[AGENTS], room, 4)
  await late.waitForTimeout(500)
  const lateSnap = await snapshot(late)
  const lateSame = lateSnap.doc === snaps[0].doc
  const errors = pages.concat(late).flatMap((p) => p.errors)

  const ops = stats.reduce((s, x) => s + x.ops, 0)
  const res = { round, ops, failed: stats.reduce((s, x) => s + x.failed, 0), offline: stats.reduce((s, x) => s + x.offline, 0), converged: snaps.every((s) => s.doc === snaps[0].doc), matchY: snaps.every((s) => s.matchesY), rendered: snaps.every((s) => s.rendered), lateJoinerMatches: lateSame, settleMs, pageErrors: errors.length, docChars: snaps[0].doc.length }
  results.push(res)
  console.log(`round ${round}: ${ops} ops (${res.failed} skipped), ${res.offline} offline spells -> ` +
    `${res.converged ? 'converged' : 'DIVERGED'} in ${settleMs}ms, Y ${res.matchY ? 'matches' : 'DIFFERS'}, screen ${res.rendered ? 'matches' : 'STALE'}, late joiner ${lateSame ? 'matches' : 'DIFFERS'}` +
    (errors.length ? `, ${errors.length} page errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}` : ''))
  if (!same || !lateSame) snaps.concat([lateSnap]).forEach((s, i) => writeFileSync(`demo/out/swarm-${SEED}-${round}-p${i}.json`, JSON.stringify(s, null, 1)))
  if (round === 1) console.log('   kinds (agent 0):', JSON.stringify(stats[0].kinds), stats.map((s) => s.lastError).filter(Boolean).slice(0, 2).join(' | '))
  await Promise.all(pages.concat(late).map((p) => p.close()))
}
await Promise.all(browsers.map((b) => b.close()))
writeFileSync(`demo/out/swarm-${SEED}.json`, JSON.stringify(results, null, 1))
const bad = results.filter((r) => !r.converged || !r.matchY || !r.rendered || !r.lateJoinerMatches)
console.log(`${results.length - bad.length}/${results.length} rounds converged`)
process.exit(bad.length ? 1 : 0)
