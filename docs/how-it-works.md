# How y-trix works

This is for people who want to read the shared document somewhere else, or work on the binding. To use it, the [README](../README.md) is enough.

## The document format

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


This format is what other programs see when they read the `Y.Text`: a server that extracts the text, another client, a migration. It will not change in a patch or minor release without a note in the release and a way to read the old one.

## The binding

- Local changes: `Composition#setDocument` is wrapped, so every change
  reaches Yjs synchronously. Trix documents are immutable and unchanged blocks
  keep their identity, so only the changed blocks are diffed (a caret-hinted
  LCS text diff, then attribute runs). A format written to Y does not
  always land as written, so after a write that deleted, formatted or
  replaced an embed the binding reads those blocks back from Y and shows
  what Y says.
- Remote changes: only the blocks the Y event touches are rebuilt; other
  Block objects are reused, so Trix re-renders only those. The caret is
  carried through the delta. If this editor is not focused, the page selection
  and focus are put back after Trix renders, because Trix's render clears the
  window selection and can move it into this editor.
- Undo: `editor.undo/redo/canUndo/canRedo` use a `Y.UndoManager` that tracks
  only this binding; Trix's own undo entries are dropped. Steps end where
  Trix's own would (it says before each change whether it is more of the
  same typing or something new), and also after a pause of `captureTimeout`
  (500 ms). A composition is one step however long it takes: by the
  pause alone, undo after a slow one brought the half-typed text back.
- Enter: Trix renders an Enter on the next animation frame, and a key that
  arrives before that frame lands in the wrong place (plain Trix does this
  too; it renders at once only on iOS). The binding makes Trix render as soon
  as the browser has finished the Enter. What the browser did to the page
  for that key is still on its way to Trix's mutation observer then, and
  Trix ignores it only while a render is waiting, so the binding drops it
  first. (Left there, it made Firefox's Trix read the whole document back
  from the page after Shift+Enter, and a line break elsewhere that the
  page showed as a newline character came back as a space.)
- Input methods: while a composition is in progress (Japanese, Chinese,
  Korean, most Android typing) any render by Trix would end it and commit
  the half-typed text. The binding keeps a second `Y.Doc` that holds exactly
  what the editor shows. During a composition that shadow stops following
  the real doc, local changes are written to it and passed on, and remote
  changes are shown when the composition ends. The shadow is created at the
  first composition or the first mouse press in the editor (see the mouse,
  below), so it costs nothing in an editor that is only read.
- Emoji: positions are UTF-16 offsets, as in Trix, and the API allows an
  edit between the two halves of an emoji (a caret cannot get there). Yjs
  cannot send half a pair, so the binding writes U+FFFD for each half and
  shows that here too.
- Trix does not redraw while an attachment is selected for editing. When a
  remote change arrives the binding deselects it, unless the user is typing
  its caption, so that other people's changes show, and in the editor the
  user is in it selects the attachment again afterwards. (Left deselected,
  nobody could get to an attachment's caption field or its remove button
  while someone else was typing.)
- The mouse: while the button is down in the editor the browser is making
  a selection from the nodes that are there, and a render by Trix would
  replace them (the selection then came out short, or from the top of the
  document in Firefox). Remote changes wait until the button is up, the
  way they wait during a composition. After a press Trix also stops
  following the selection until the mouse moves or 200 ms have passed, so
  for that moment the binding reads the caret from the page: a change from
  someone else right after a click used to put the caret back where it was
  before the click.
- The reader's place: Trix makes all its nodes anew at every render, so
  the browser does not keep what is on screen where it is, and lines that
  someone adds above pushed what the user was reading or typing down the
  screen. Before a remote change is shown the binding notes what is at
  the top of the visible part of the editor and where (a child element, by
  its place among its siblings and the start of its text; in a long list,
  the item), and afterwards scrolls whatever scrolls (the editor, a box
  around it, or the page) by as much as it moved. That measures the page
  after the render, which at 2,000 blocks takes about as long again as
  the render did. With the start of the document in view nothing is
  scrolled. Two editors on one page that show the same change each scroll
  the page for it.
- With the end of a block and the start of the next selected (Shift and
  the right arrow at the end of a line), Chromium's Trix says the
  selection is a caret, though the page has the block break selected and
  the next key replaces it. The binding reads the page then: put back as
  a caret after a remote change, the key no longer joined the two blocks.
- A selection made backwards (Shift and the left arrow) is put back
  backwards after a remote change, in this editor and when the selection
  is somewhere else on the page. A range alone runs forwards, and the next
  Shift and arrow then moved the wrong end (seen in Firefox).
- A format switched on or off with nothing selected (Italic, then type)
  lives in Trix's current attributes and not in the document. Trix drops
  it when the selection is set again, so the binding puts it back after a
  remote change.
- While a toolbar dialog is open (the link field) Trix holds the selection:
  it marks the selected text with a `frozen` attribute, which shows it
  highlighted, and keeps the range as fixed positions. Neither is content.
  `frozen` is never written to Y and never taken from it, and the binding
  keeps the range as Yjs positions and gives Trix the new one after each
  remote change. (Shared, the highlight showed in everyone's editor, the
  link went on whatever stood at the old positions after someone else's
  edit, and the highlight was left in the document.)
- Remote carets and selections are drawn in an overlay appended to
  `document.body`, at most once per animation frame.
- Attachments keep their Trix `Attachment` object across remote rebuilds.
  An attribute change made in place (an upload finishing) is shared as a
  new embed. An editor that gets such a replacement keeps the object it
  has and gives it the new attributes: with a new object, a caption its
  user was typing on the attachment was lost, and Trix threw when they
  finished.
- The focus in a text field (an attachment's caption, a field elsewhere
  on the page) stays there through a remote change, with its caret. The
  binding notes the caret when the user does something in the field,
  because the field itself can say 0 after Trix has rendered, and puts it
  back. (Safari otherwise stopped sending the field the keys.)
- Trix measures an image when it has loaded and gives an attachment that
  has no `width` and `height` the ones it found. Every editor showing the
  image does that. Only the editor the attachment was put in shares them;
  an editor that got the attachment from the shared document keeps what it
  measured to itself. (When all of them wrote it, the image was in the
  document once per editor.)
- The diff gives each different attachment a character of its own and
  counts a kept character of text for more than a kept attachment or block
  break, so that what stays is not taken out and written again: two people
  doing that at the same moment would leave it in the document twice.
- Cost at 2,000 blocks: about 0.15 ms of binding work per local change.
  A remote change costs about what a local keystroke costs (about 18 ms,
  nearly all Trix's own render).

## Untrusted content

What a peer puts in the Y doc is shown in everyone else's editor, so the
binding treats it as untrusted. Before it builds a Trix document from Y it
keeps only the text and block attributes Trix is configured for, drops
`javascript:` and other script URLs from links and attachments, checks the
types of attachment attributes, shows an embed that is not an attachment as
`\ufffd`, and deletes the `"\r"` of a `"\r\n"` (Trix would drop it and its
positions would no longer match Y). A failure while applying a remote change
is logged and the editor is redrawn from Y.

The HTML in a content attachment is sanitized by Trix itself, which older
releases did not do: Trix 2.0 runs script found there. That is why the peer
dependency is Trix 2.1.15 or later, and the binding warns on anything older.

## Limits of the approach

- Changes are applied piece by piece. As a backstop, a quarter of a second
  after the last change the binding compares the editor with Y read from
  scratch and redraws it if they differ, logging what differed. It used to
  fire about once in 100 runs of the wide fuzz. Both causes found are fixed
  (Yjs leaves an embed that is not an object out of its change events, and
  does not always leave a format as it was written). A third turned up
  later and is fixed too: a format marker that Yjs deletes as redundant
  changes what a character reads as, in a change event that says nothing
  changed. It has not fired in the fuzz runs since. If it does fire, that
  editor was wrong until then, and an edit made in that moment can have
  landed in the wrong place.
- Trix moves attachments marked as a gallery into a block of their own.
  The binding lets it do that only as part of a local edit. A merge can
  leave gallery attachments inside a text block, and they stay there, shown
  inline, until someone edits the document.
- Yjs itself: an insert, delete or format made through the Yjs API at a
  position inside an emoji (between the two halves of a surrogate pair) can
  leave two Y docs unequal. The binding never writes there, but another
  client of the same document could. (Half an emoji inserted as text
  is mended: the editors on that doc replace it with U+FFFD, which is what
  every other doc received.)
- Yjs formats a block break as a range around one character. Text inserted
  concurrently right after that range can pick up the block attributes,
  depending on client order, and undo can restore format markers. Both peers
  get the same result. The binding treats block attributes on anything but a
  block break as noise.
- An attachment whose attributes two people change at the same moment
  (not its caption, which is kept apart) is in the document twice
  afterwards, once with each change: a changed attachment is a new embed.
  Set attributes in one editor, as an upload does.
- An image that is in the shared document without `width` and `height`
  and was not put in by an editor that is still open (one seeded on a
  server, say) never gets them there. Each editor shows and saves it with
  the size it measured; the plain `Y.Text` has it without.
- A file attachment is shared before it is uploaded, without its file. Other
  peers see it once the app's upload handler sets `url`. Until then the
  editor that added it saves it with Trix's pending-upload marker and the
  others do not.
- Undo steps end where Trix's own would, with two differences. A pause
  of `captureTimeout` also ends one. And a step that changed nothing in
  the end (a space typed and deleted again) is skipped: Yjs goes on to the
  step before it, where Trix alone spends an undo on showing the same
  document. (`tests/alone.spec.js` with undo and redo added to its buttons
  shows both; one such difference looked at closely was the second.)
- A space next to a line break made with Shift+Enter is a non-breaking
  space in the page while it is typed (the browser makes it one so that it
  shows). When Trix draws the block again it can draw a plain space there,
  which does not show, and Chromium types the next key on the wrong side
  of it. After a remote change is drawn the binding makes such a space
  non-breaking in the page again (`keepSpacesBeforeBreaks`); the document
  is the same either way. Trix alone does this to itself now and then: at
  the end of a block, the End key and a letter can put the letter before a
  space that was typed there. With `ALONE_NOISE=1`, `tests/alone.spec.js`
  has someone else type a character and take it away again between the
  user's keys, and about one Chromium run in fifteen ends differently from
  Trix alone, most of them this way round: the binding has the letter
  after the space, Trix alone before it. One (`ALONE_SEEDS=5`) has Bold
  switched on after a pasted picture with the binding and not without,
  which is not explained yet. Firefox and WebKit had none in 40 runs.
- A picture that does not load (a dead link) makes Trix draw the whole
  document again on every key typed in its block, with or without the
  binding: the `<img>` it would draw is not the one it kept in the page.
- Yjs undo has two open bugs with nested types, yjs/yjs#823 (peers can
  diverge after undo) and yjs/yjs#809 (undo can throw). A single flat
  `Y.Text` does not seem to reach them: `node notes/yjs-undo-text.mjs` fuzzes
  this data model in plain Yjs with undo and gets 0 divergences and 0
  exceptions in 50,000 runs. The binding still catches an exception from
  undo or redo and redraws the editor from Y.
- Tested with Trix 2.1.19 in Chromium, WebKit and Firefox, and with Trix
  2.1.15 in Chromium.
