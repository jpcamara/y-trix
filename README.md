# y-trix

Collaborative editing for the [Trix](https://trix-editor.org) editor, built
on [Yjs](https://yjs.dev).

- Several people edit the same Trix document at once, and everyone ends up
  with the same content.
- Each person sees the others' carets and selections.
- Undo and redo only take back your own changes.
- It works with any Yjs provider (y-websocket, y-indexeddb, your own).

There is a live demo at [yrby.dev/demos/trix](https://yrby.dev/demos/trix):
open it in two windows.

## Install

```sh
npm install y-trix trix yjs y-protocols
```

`trix` (2.1.15 or later), `yjs` (13.6) and `y-protocols` are peer
dependencies, so you choose their versions. TypeScript types are included.

## Quick start

```html
<link rel="stylesheet" href="https://unpkg.com/trix@2/dist/trix.css">
<trix-editor></trix-editor>
```

```js
import 'trix'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { TrixBinding } from 'y-trix'

const doc = new Y.Doc()
const provider = new WebsocketProvider('wss://your-server.example', 'room-name', doc)

// Who this person is, for the caret everyone else sees.
provider.awareness.setLocalStateField('user', { name: 'Alice', color: '#e6194b' })

const binding = new TrixBinding(
  doc.getText('trix'),                    // where the document lives
  document.querySelector('trix-editor'),  // the editor to bind
  provider.awareness                      // optional: carets and selections
)
```

That is all of it. Type in the editor and it is written to the `Y.Text`;
changes from other people show up in the editor.

When you are done with the editor:

```js
binding.destroy()
```

## API

### `new TrixBinding(ytext, element, awareness?, options?)`

| Argument | |
|---|---|
| `ytext` | A `Y.Text`. The whole document is stored in it. Use one per editor, and let nothing else write to it. |
| `element` | A `<trix-editor>` element. It does not have to be ready yet: if Trix has not set it up, the binding attaches when it has. |
| `awareness` | Optional. A y-protocols `Awareness` (every provider has one). Without it there are no shared carets. |
| `options` | Optional, see below. |

| Option | Default | |
|---|---|---|
| `undoManager` | a new one | Your own `Y.UndoManager`, for instance one shared by several editors. The binding adds itself to its tracked origins. You destroy it. |
| `captureTimeout` | `500` | How long a pause, in milliseconds, ends an undo step. Ignored if you pass `undoManager`. |
| `cursors` | `true` | `false` stops the binding drawing other people's carets. Your own selection is still published, so you can draw them yourself. |
| `attachments` | `true` | `false` refuses files and does not show attachments that are in the document. See [Attachments](#attachments). |
| `Trix` | `globalThis.Trix` | The Trix object, if your setup does not put it on the global. `import 'trix'` does. |

### `binding.ready`

A promise that resolves with the binding once it is attached to the editor.
That is immediately for an editor Trix has already set up, and after
`trix-initialize` otherwise.

### `binding.undoManager`

The `Y.UndoManager` behind `element.editor.undo()` and `redo()`, the toolbar
buttons and the keyboard shortcuts. It is available once `ready` resolves.

### `binding.destroy()`

Detaches the binding and gives Trix its own undo back. The editor keeps the
content it has. Safe to call more than once.

## Guides

### Starting with existing content

When the binding attaches, the shared document wins if it has anything in
it. If it is empty, the binding copies in whatever the editor holds.

That second case needs care. If two people open an editor that both start
with the same saved HTML, and neither has received the shared document yet,
both copy it in and the content appears twice. Two ways to avoid it:

- **Wait for the first sync, then bind.** By then the shared document has
  whatever anyone else wrote, and only the very first person seeds it.

  ```js
  provider.once('sync', () => {
    new TrixBinding(doc.getText('trix'), element, provider.awareness)
  })
  ```

- **Seed on the server**, or in one place, so that browsers never start from
  an empty shared document.

### Saving, and Rails with Action Text

Trix keeps its hidden form input up to date as usual, including after other
people's changes. So a normal form submit still sends the current HTML, and
Action Text needs no changes: whoever saves, saves what everyone sees.

There is no server-side renderer in this package. The HTML comes from a
browser. If you need the content on a server without one, you can read the
plain text from the `Y.Text`; see
[the document format](docs/how-it-works.md#the-document-format).

### Attachments

Attachments are shared like any other content, including their captions.

- **Uploads work the way they do in plain Trix.** Listen for
  `trix-attachment-add`, upload `event.attachment.file`, and call
  `event.attachment.setAttributes({ url, href })` when it is done. The
  binding shares the attributes when you set them. Check that
  `attachment.file` exists before uploading, as Trix's own example does:
  everyone's editor fires the event, and only the person who added the file
  has it.
- **Until the upload finishes**, other people see the attachment without its
  file.
- **To switch attachments off**, pass `{ attachments: false }`. Files are
  refused, and an attachment that is already in the document shows as a
  placeholder character in that editor.

### Styling the carets

Other people's carets are drawn in a layer appended to `document.body`:

```html
<div class="y-trix-cursors">
  <div class="y-trix-selection"></div>   <!-- one per line of a selection -->
  <div class="y-trix-caret">
    <div class="y-trix-caret-label">Alice</div>
  </div>
</div>
```

The name and colour come from each person's `user` awareness field,
`{ name, color }`. The colour is also set as `--y-trix-color` on the caret
and the selection. Position and colour are inline styles, so a rule that
changes how they look needs `!important`:

```css
.y-trix-caret-label { font: 11px system-ui !important; border-radius: 4px !important; }
```

To draw them entirely your own way, pass `{ cursors: false }` and read the
`cursor` field of each awareness state: `{ anchor, head }`, both Yjs
relative positions into the `Y.Text`.

### Undo

`element.editor.undo()`, the toolbar buttons and the keyboard shortcuts all
go through a `Y.UndoManager` that tracks only this editor's changes. Undo
steps end where Trix's own would, and a whole input-method composition
(Japanese, Chinese, Korean, most Android keyboards) is one step.

### Content from other people is untrusted

Whatever is in the shared document ends up in everyone's editor, so the
binding checks it first: it keeps only the formatting Trix is configured
for, drops `javascript:` and similar URLs, and validates attachments. Trix
sanitises attachment HTML itself, and 2.1.15 is the oldest release without
a published XSS advisory, which is why older versions are not supported.
Details are in [how it works](docs/how-it-works.md#untrusted-content).

## Limitations

- **Attachment galleries after a merge.** Trix groups gallery images into
  their own block. If two people's edits merge so that gallery images land
  inside a text block, they stay inline until someone edits the document.
- **A file is visible to others before it is uploaded**, without its
  content, until your upload handler sets its `url`.
- **Positions inside an emoji.** Another program writing to the same
  `Y.Text` at a position between the two halves of an emoji can leave
  documents unequal. The binding never does this itself.
- **Other tools writing to the document.** The binding expects to be the
  only writer of its `Y.Text`. It tolerates and cleans up most things, but a
  document written in another format is not supported.

The full list, with the reasons, is in
[Limits of the approach](docs/how-it-works.md#limits-of-the-approach).

## Tested with

Trix 2.1.19 and 2.1.15, in Chromium, Firefox and WebKit. The test suite
includes fuzzers that hold every editor to showing the same document under
random edits, lost and reordered network updates, and input-method typing.

## More

- [How it works](docs/how-it-works.md): the document format, the binding,
  and the limits of the approach.
- [Working on y-trix](docs/development.md): the demo, the tests and the
  fuzzers.

## Security

If you find a way for one user to run code in, or break, another user's
editor, please report it privately through
[GitHub's vulnerability reporting](https://github.com/jpcamara/y-trix/security/advisories/new)
and not in a public issue.

## License

[MIT](LICENSE)
