import 'trix'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { TrixBinding } from '../src/y-trix.js'

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4']
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve']
const params = new URLSearchParams(location.search)
const peers = []
window.ytDemo = { peers, Y, TrixBinding, ready: null }

async function createPeer (name, color) {
  const id = name.toLowerCase().replace(/[^a-z]+/g, '')
  const wrap = document.createElement('div')
  wrap.className = 'peer'
  wrap.innerHTML = `<h3 style="color:${color}">${name}</h3><input type="hidden" id="${id}-input"><trix-editor id="${id}" input="${id}-input"></trix-editor>`
  const element = wrap.querySelector('trix-editor')
  const ready = new Promise((resolve) => element.addEventListener('trix-initialize', resolve, { once: true }))
  document.getElementById('peers').appendChild(wrap)
  await ready
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalStateField('user', { name, color })
  const binding = new TrixBinding(doc.getText('trix'), element, awareness, { debug: params.has('debug') })
  const peer = { name, id, doc, awareness, element, editor: element.editor, binding }
  peers.push(peer)
  return peer
}

const online = () => document.getElementById('online').checked
const delay = () => Number(document.getElementById('delay').value) || 0
// window.ytDemo.chaos = () => (a number in [0, 1)) makes the network a bad
// one: updates arrive late and out of order, some twice, some never (until
// the next full sync), and some merged with others into one update.
const batches = new Map()
const deliver = (fn, update, other) => {
  const chaos = window.ytDemo.chaos
  if (!chaos) return setTimeout(fn, delay())
  const r = chaos()
  if (r < 0.06) return // lost
  if (update && r > 0.7) {
    // held back and delivered with whatever else is held, as one update
    if (!batches.has(other)) {
      batches.set(other, [])
      setTimeout(() => { const all = batches.get(other); batches.delete(other); Y.applyUpdate(other.doc, Y.mergeUpdates(all), 'remote') }, delay() * 4)
    }
    batches.get(other).push(update)
    return
  }
  setTimeout(fn, delay() * 8 * chaos())
  if (r < 0.14) setTimeout(fn, delay() * 8 * chaos()) // and again
}

function connect (peer) {
  peer.doc.on('update', (update, origin) => {
    if (origin === 'remote' || !online()) return
    for (const other of peers) if (other !== peer) deliver(() => Y.applyUpdate(other.doc, update, 'remote'), update, other)
  })
  peer.awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === 'remote' || !online()) return
    const u = awarenessProtocol.encodeAwarenessUpdate(peer.awareness, added.concat(updated, removed))
    for (const other of peers) if (other !== peer) deliver(() => awarenessProtocol.applyAwarenessUpdate(other.awareness, u, 'remote'))
  })
}

function syncAll () {
  for (const a of peers) {
    for (const b of peers) {
      if (a === b) continue
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), 'remote')
      const u = awarenessProtocol.encodeAwarenessUpdate(a.awareness, Array.from(a.awareness.getStates().keys()))
      awarenessProtocol.applyAwarenessUpdate(b.awareness, u, 'remote')
    }
  }
}

async function main () {
  const a = await createPeer(NAMES[0], COLORS[0])
  connect(a)
  if (!params.has('empty')) {
    a.editor.loadHTML('<div>Hello <strong>world</strong>. Edit me in either editor.</div><div>Second paragraph.</div>')
    a.binding.undoManager.clear()
  }
  const b = await createPeer(NAMES[1], COLORS[1])
  connect(b)
  syncAll()
  document.getElementById('online').addEventListener('change', () => { if (online()) syncAll() })
  document.getElementById('join').addEventListener('click', () => window.ytDemo.addPeer())
}

window.ytDemo.addPeer = async () => {
  const i = peers.length
  const p = await createPeer(NAMES[i], COLORS[i])
  connect(p)
  syncAll()
  return p.name
}
window.ytDemo.syncAll = syncAll

// ---- one peer per page, through the real providers ------------------------
// ?mode=yws&room=r&peer=0..4 syncs through y-websocket (server on &wsport,
// default 5185). &persist also stores the doc with y-indexeddb, and &nows
// leaves the network out. window.ytDemo.net.setOnline(false) disconnects.
async function yWebsocket () {
  document.querySelector('.controls').style.display = 'none'
  const n = Number(params.get('peer') || 0) % NAMES.length
  const room = params.get('room') || 'default'
  const p = await createPeer(NAMES[n], COLORS[n])
  const net = { provider: null, persistence: null }
  if (params.has('persist')) {
    net.persistence = new IndexeddbPersistence('y-trix-' + room, p.doc)
    await net.persistence.whenSynced
  }
  if (!params.has('nows')) {
    // No BroadcastChannel shortcut between tabs: everything goes through the server.
    net.provider = new WebsocketProvider(`ws://${location.hostname}:${params.get('wsport') || 5185}`, room, p.doc, { awareness: p.awareness, disableBc: true })
    await new Promise((resolve) => net.provider.synced ? resolve() : net.provider.once('sync', resolve))
  }
  net.setOnline = (on) => on ? net.provider.connect() : net.provider.disconnect()
  window.ytDemo.net = net
}

window.ytDemo.ready = (params.get('mode') === 'yws' ? yWebsocket() : main()).then(() => true)
