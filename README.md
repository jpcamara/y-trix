# y-trix (prototype)

Yjs binding for [Trix](https://github.com/basecamp/trix) 2. Proprietary; all
rights reserved. `trix`, `yjs` and `y-protocols` are peer dependencies; no
Trix code is bundled.

```js
import 'trix'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { TrixBinding } from 'y-trix'

const doc = new Y.Doc()
const awareness = new Awareness(doc)
awareness.setLocalStateField('user', { name: 'Alice', color: '#e6194b' })
element.addEventListener('trix-initialize', () => {
  const binding = new TrixBinding(doc.getText('trix'), element, awareness)
  // later
  binding.destroy()
})
```

## Data model

One `Y.Text` for the whole document, in the shape of Trix's own model. Trix
documents are blocks of attributed pieces, each block ending in a `"\n"` piece
marked `blockBreak`, and Trix positions count every character, breaks
included. So:

- string pieces are Y text with their attributes (`bold`, `href`, ...),
- an attachment is a one-character embed `{ attachment: {...} }` with the
  piece's attributes (`caption`, `presentation`),
- a block break is a `"\n"` formatted `{ blockBreak: true, block?, html? }`
  with the block's attributes (`["quote", "bulletList", "bullet"]`) and HTML
  attributes. A `"\n"` without `blockBreak` is a soft line break.

Why not a `Y.Array` of blocks, each with its own `Y.Text`? A Trix position
is a Y index, so selections, relative positions and remote carets need no
mapping. Splitting a block (Enter) and merging two (Backspace) are
one-character inserts and deletes, so text never moves between Y types.
With per-block types a merge would move text between them and lose
concurrent edits. Changing a block's attributes formats one character.

## How it works

- Local changes: `Composition#setDocument` is wrapped, so every change
  reaches Yjs synchronously. Trix documents are immutable and unchanged blocks
  keep their identity, so only the changed blocks are diffed (a caret-hinted
  LCS text diff, then attribute runs).
- Remote changes: only the blocks the Y event touches are rebuilt; other
  Block objects are reused, so Trix re-renders only those. The caret is
  carried through the delta. If this editor is not focused, the page selection
  and focus are put back after Trix renders, because Trix's render clears the
  window selection and can move it into this editor.
- Undo: `editor.undo/redo/canUndo/canRedo` use a `Y.UndoManager` that tracks
  only this binding; Trix's own undo entries are dropped.
- Enter: Trix renders an Enter on the next animation frame, and a key that
  arrives before that frame lands in the wrong place (plain Trix does this
  too; it renders at once only on iOS). The binding makes Trix render as soon
  as the browser has finished the Enter.
- Input methods: while a composition is in progress (Japanese, Chinese,
  Korean, most Android typing) any render by Trix would end it and commit
  the half-typed text. The binding keeps a second `Y.Doc` that holds exactly
  what the editor shows. During a composition that shadow stops following
  the real doc, local changes are written to it and passed on, and remote
  changes are shown when the composition ends. The shadow is created at the
  first composition, so it costs nothing until an input method is used.
- Remote carets and selections are drawn in an overlay appended to
  `document.body`.
- Attachments keep their Trix `Attachment` object across remote rebuilds.
  An attribute change made in place (an upload finishing) is shared as a
  new embed.
- Cost at 2,000 blocks: about 0.15 ms of binding work per local change.
  A remote change costs about what a local keystroke costs (about 18 ms,
  nearly all Trix's own render).

## Untrusted content

What a peer puts in the Y doc is shown in everyone else's editor, so the
binding treats it as untrusted. Before it builds a Trix document from Y it
keeps only the text and block attributes Trix is configured for, drops
`javascript:` and other script URLs from links and attachments, checks the
types of attachment attributes, shows an embed that is not an attachment as
`\ufffd`, and rewrites `"\r"` (which Trix would silently change). A failure
while applying a remote change is logged and the editor is redrawn from Y.

The HTML in a content attachment is sanitized by Trix itself, which older
releases did not do: Trix 2.0 runs script found there. That is why the peer
dependency is Trix 2.1.15 or later, and the binding warns on anything older.

## Demo and tests

```sh
npm install
npm test                     # builds demo/dist and runs Playwright
node demo/server.js          # http://localhost:5175/ (run `npm run build:demo` first)
```

The demo shows two editors with their own `Y.Doc`s connected in the page
(online toggle, delay, "add late joiner").

Tests run in Chromium, WebKit and Firefox; `BROWSERS=chromium,webkit` picks
engines. On macOS the config starts Firefox with a stand-in home folder,
because macOS 27 denies it its usual app-data folder. The `chromium-trix2.1.15`
project reruns the sync and security tests against the oldest supported
Trix (`?trix=2.1.15` on the demo page).

`tests/provider.spec.js` runs the binding through the real providers, one
editor per browser context: `y-websocket` (two browsers, offline edits and
reconnect, a late joiner after everyone left) and `y-indexeddb` (reload).
The y-websocket tests run against two servers: `@y/websocket-server` 0.1.1,
the last release on Yjs 13, with LevelDB persistence, and 0.1.5, the latest,
which runs Yjs 14 inside and speaks the same protocol. 0.1.5 needs
`@y/protocols` pinned to 1.0.6-1 (see `overrides` in package.json), or it
loads two copies of Yjs and fails on every update. Yjs 14 itself (`@y/y`)
is a release candidate with a different type API and is not supported.
The demo page is `?mode=yws&room=r&peer=0` (`&persist` adds y-indexeddb);
start a
server with `PORT=5185 node node_modules/y-websocket-server-13/src/server.js`.

`node demo/swarm.mjs` (see its header) runs four separate browsers, mixing
Chromium, WebKit and Firefox, that edit one document at random through
y-websocket with offline spells and undo, then checks that all of them and
a late joiner hold the same document.

Fuzzing: `FUZZ_SEEDS=1,2,3 FUZZ_OPS=150 npx playwright test -g fuzz`
(`FUZZ_NO_UNDO=1` drops undo from the op mix).

## Known problems

- Yjs formats a block break as a range around one character. Text inserted
  concurrently right after that range can pick up the block attributes,
  depending on client order, and undo can restore format markers. Both peers
  get the same result. The binding treats block attributes on anything but a
  block break as noise.
- A file attachment is shared before it is uploaded, without its file. Other
  peers see it once the app's upload handler sets `url`.
- Yjs undo has two open bugs with nested types, yjs/yjs#823 (peers can
  diverge after undo) and yjs/yjs#809 (undo can throw). A single flat
  `Y.Text` does not seem to reach them: `node notes/yjs-undo-text.mjs` fuzzes
  this data model in plain Yjs with undo and gets 0 divergences and 0
  exceptions in 50,000 runs. The binding still catches an exception from
  undo or redo and redraws the editor from Y.
- Tested with Trix 2.1.19 in Chromium, WebKit and Firefox, and with Trix
  2.1.15 in Chromium.
