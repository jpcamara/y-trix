import 'trix'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { TrixBinding } from '../src/y-trix.js'

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4']
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve']
const params = new URLSearchParams(location.search)
const peers = []
window.ytDemo = { peers, Y, ready: null }

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
  const binding = new TrixBinding(doc.getText('trix'), element, awareness)
  const peer = { name, id, doc, awareness, element, editor: element.editor, binding }
  peers.push(peer)
  return peer
}

const online = () => document.getElementById('online').checked
const delay = () => Number(document.getElementById('delay').value) || 0
const deliver = (fn) => setTimeout(fn, delay())

function connect (peer) {
  peer.doc.on('update', (update, origin) => {
    if (origin === 'remote' || !online()) return
    for (const other of peers) if (other !== peer) deliver(() => Y.applyUpdate(other.doc, update, 'remote'))
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
window.ytDemo.ready = main().then(() => true)
