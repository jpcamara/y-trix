# Working on y-trix

```sh
npm install
npm test                     # builds demo/dist and runs Playwright
node demo/server.js          # http://localhost:5175/ (run `npm run build:demo` first)
```

The demo shows two editors with their own `Y.Doc`s connected in the page
(online toggle, delay, "add late joiner"). `?debug` turns the binding's
self-check on.

Tests run in Chromium, WebKit and Firefox; `BROWSERS=chromium,webkit` picks
engines. On macOS the config starts Firefox with a stand-in home folder,
because macOS 27 denies it its usual app-data folder. The `chromium-trix2.1.15`
project reruns the sync and security tests against the oldest supported
Trix (`?trix=2.1.15` on the demo page).

`.github/workflows/test.yml` runs the suite and the fuzzes below on every
pull request.

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

`tests/wide.spec.js` is a wider fuzz with three editors: attachments,
pasted HTML, nesting, undo and redo, offline spells, and positions inside
emoji. `WIDE_SEEDS=1,2,3 WIDE_OPS=160 npx playwright test wide` picks runs.

`WIDE_KEYS=1` adds what only the keyboard and the clipboard do: cut, paste
and drop events with clipboard data, pasted files, Delete, Tab, word
delete, arrow keys, select-all and type. `WIDE_CHAOS=1` gives it a bad network: updates arrive
late and out of order, some twice, some never until the next full sync, and
some merged into one. `tests/ime.spec.js` drives real compositions through
the DevTools protocol (Chromium only) while remote changes arrive.
`tests/lifecycle.spec.js` covers the editor and the binding coming and
going: the element hidden, disabled, taken out of the page and put back, a
whole document loaded over everything, a binding destroyed and made again,
two editors on one `Y.Doc`.

Fuzzing: `FUZZ_SEEDS=1,2,3 FUZZ_OPS=150 npx playwright test -g fuzz`
(`FUZZ_NO_UNDO=1` drops undo from the op mix).

`tests/caret.spec.js` holds one user's caret (or selection) to staying with
its text while two others edit at random: after each of their edits it has
to be where a Yjs relative position taken beforehand says it is.

`tests/ui.spec.js` is about what a user is in the middle of: a click just
made, a selection being dragged with the mouse, a selection made backwards
with the keyboard, a format switched on for the next key, the link dialog
with words selected. Each round the user starts one of these with the real
mouse and keys, two others edit at random, and the user finishes; the
selection, the key or the link has to be where Yjs positions taken
beforehand say (`UI_SEEDS=1,2,3 UI_ROUNDS=40`).

`tests/undo.spec.js` has one user edit at random and then undo everything
while two others put in numbered words: every word has to be there
afterwards, and nothing the first user typed may be left.

`tests/keep.spec.js` has three users type and restructure the document
around each other, nobody deleting anything, on a bad network with offline
spells, and holds every character typed to being in the document exactly
once at the end (`KEEP_SEEDS=1,2,3 KEEP_OPS=150`). It also fails on any
write that puts in text or an attachment the document already had.

`tests/odd.spec.js` writes 56 odd things into Y one at a time
(values of the wrong type, names like `constructor`, control characters,
half an emoji) and types next to each.

`tests/break.spec.js` writes shapes Trix would never make straight into Y
from three editors while one of them types (`BREAK_SEEDS=1,2,3
BREAK_ROUNDS=40`).

`new TrixBinding(ytext, element, awareness, { debug: true })` makes the
binding compare its editor with Y after every step and log the first step
that leaves them different, with the steps before it (slow; for tests).
`DEBUG_SYNC=1` turns it on for every test and fails the test on a report;
`STRICT=1` also fails the two fuzzes if the settle check (see
[Limits of the approach](how-it-works.md#limits-of-the-approach)) ever has to redraw. `SLOW=6` slows Chromium's CPU six times.
