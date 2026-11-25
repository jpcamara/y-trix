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
- Remote carets and selections are drawn in an overlay appended to
  `document.body`.
- Attachments keep their Trix `Attachment` object across remote rebuilds.
  An attribute change made in place (an upload finishing) is shared as a
  new embed.
- Cost at 2,000 blocks: about 0.15 ms of binding work per local change.
  A remote change costs about what a local keystroke costs (about 18 ms,
  nearly all Trix's own render).

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
because macOS 27 denies it its usual app-data folder.

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
- Yjs undo has two open bugs, yjs/yjs#823 (peers can diverge after undo)
  and yjs/yjs#809 (undo can throw). The binding catches an exception from
  undo or redo and redraws the editor from Y, so the editor never disagrees
  with its own Y doc. Creating the `Y.Doc` with `{ gc: false }` avoids the
  exception, at the cost of a larger doc.
- Tested with Trix 2.1.19 in Chromium, WebKit and Firefox.
