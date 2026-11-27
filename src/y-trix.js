// y-trix: a Yjs binding for Trix.
//
// Data model. A Trix document is a list of blocks; each block is a list of
// pieces (attributed strings and attachments) that ends in a "\n" piece marked
// blockBreak. Trix positions count every piece character, block breaks
// included. The whole document is mirrored into one Y.Text with exactly that
// shape:
//
//   - a string piece is Y text with the piece's attributes (bold, href, ...)
//   - an attachment is a one-character embed { attachment: {...attributes} }
//     carrying the piece's attributes (caption, presentation)
//   - a block break is a "\n" formatted { blockBreak: true, block?: [...],
//     html?: {...} } holding the block's attributes and HTML attributes
//
// So a Trix position is a Y.Text index, a block split or merge is a single
// character insert or delete (no text moves between Y types, so concurrent
// edits next to the split are kept), and changing a block's attributes
// formats one character.
//
// Local changes are taken synchronously from Composition#setDocument. Trix
// documents are immutable and unchanged blocks keep their identity, so the
// diff only looks at the blocks that changed. Remote changes rebuild only the
// affected blocks and keep the rest, so Trix re-renders just those.

import * as Y from 'yjs'
import { textDiff } from './text-diff.js'


const SURROGATE = /[\ud800-\udfff]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const stable = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}
const equal = (a, b) => a === b || stable(a) === stable(b)

const isEmptyObject = (o) => !o || Object.keys(o).length === 0

// Trix measures an image when it has loaded, and gives an attachment that
// has no width and height the ones it found. Every editor showing the
// attachment does that. Only the editor the attachment was put in writes
// them to Y: an editor that got the attachment from Y keeps what it measured
// to itself, or the attachment would be written once more by each of them
// and be in the document that many times.
const fromY = new WeakSet() // attachments made from an embed in Y
const measured = new WeakMap() // such an attachment -> the { width, height } Trix found by loading it
/** An attachment's attributes as they are shared. */
const sharedAttrs = (attachment) => {
  const attrs = attachment.getAttributes()
  const own = measured.get(attachment)
  if (!own || attrs.width !== own.width || attrs.height !== own.height) return attrs
  const { width, height, ...rest } = attrs
  return rest
}

// While a toolbar dialog is open (the link field) Trix holds the selection:
// it marks the selected text `frozen`, which shows it highlighted, and keeps
// the range as fixed positions. That is one editor's selection, not
// content: `frozen` is never written to Y and never taken from it.
const FROZEN = 'frozen'
/** A piece's attributes as they are shared. */
const sharedPieceAttrs = (piece) => {
  const attrs = piece.getAttributes()
  if (!(FROZEN in attrs)) return attrs
  const { [FROZEN]: _, ...rest } = attrs
  return rest
}

/**
 * Y attributes of a block's break character. Trix can leave text attributes
 * on the break piece (bold applied across a block boundary), so they are kept.
 */
const breakAttrs = (block, piece) => {
  const attrs = { ...sharedPieceAttrs(piece), blockBreak: true }
  delete attrs.block
  delete attrs.html
  if (block.attributes.length > 0) attrs.block = block.attributes.slice()
  if (!isEmptyObject(block.htmlAttributes)) attrs.html = { ...block.htmlAttributes }
  return attrs
}

/**
 * Flatten Trix blocks into runs: { str, attrs } or { embed, attrs, attachment }.
 * @param {any[]} blocks
 */
const trixRuns = (blocks) => {
  const runs = []
  for (const block of blocks) {
    for (const piece of block.text.getPieces()) {
      if (piece.attachment) {
        runs.push({ embed: { attachment: sharedAttrs(piece.attachment) }, attrs: sharedPieceAttrs(piece), attachment: piece.attachment })
      } else if (piece.isBlockBreak()) {
        runs.push({ str: '\n', attrs: breakAttrs(block, piece) })
      } else {
        runs.push({ str: piece.toString(), attrs: sharedPieceAttrs(piece) })
      }
    }
  }
  return runs
}

/**
 * Runs as a string to diff. Each different attachment is a character of its
 * own (from the private use area), so that the diff keeps an attachment that
 * is on both sides and does not take one for another.
 * @param {Map<string, string>} seen attachments met so far and their characters
 */
const runsString = (runs, seen) => runs.map((r) => {
  if (!r.embed) return r.str
  const key = stable(r.embed)
  if (!seen.has(key)) seen.set(key, String.fromCharCode(0xe000 + (seen.size % 6400)))
  return seen.get(key)
}).join('')

/** Per-character view of runs: [run, offsetInRun] for each character. */
const charIndex = (runs) => {
  const out = []
  for (const r of runs) {
    const n = r.embed ? 1 : r.str.length
    for (let i = 0; i < n; i++) out.push(r)
  }
  return out
}

/**
 * A string that is equal for blocks that hold the same thing, however Trix
 * happens to have cut the text into pieces.
 */
const blocksSig = (blocks) => stable(blocks.map((b) => {
  const runs = []
  for (const p of b.text.getPieces()) {
    const attrs = stable(sharedPieceAttrs(p))
    const last = runs[runs.length - 1]
    if (!p.attachment && last && typeof last[0] === 'string' && last[1] === attrs) last[0] += p.toString()
    else runs.push([p.attachment ? { att: sharedAttrs(p.attachment) } : p.toString(), attrs])
  }
  return [b.attributes, b.htmlAttributes || {}, runs]
}))
const docSig = (document) => blocksSig(document.getBlocks())

/** Y.Text delta ops as runs. */
const deltaRuns = (delta) => delta.map((op) =>
  typeof op.insert === 'string'
    ? { str: op.insert, attrs: op.attributes || {} }
    : { embed: op.insert, attrs: op.attributes || {} })

/** Slice runs to the character range [from, to). */
const sliceRuns = (runs, from, to) => {
  const out = []
  let pos = 0
  for (const r of runs) {
    const n = r.embed ? 1 : r.str.length
    const s = Math.max(from, pos)
    const e = Math.min(to, pos + n)
    if (s < e) out.push(r.embed ? r : { str: r.str.slice(s - pos, e - pos), attrs: r.attrs })
    pos += n
    if (pos >= to) break
  }
  return out
}

/** Attribute patch turning `from` into `to` (null removes). */
const attrPatch = (from, to) => {
  const patch = {}
  for (const k in from) if (!(k in to)) patch[k] = null
  for (const k in to) if (!equal(from[k], to[k])) patch[k] = to[k]
  return patch
}

const textAttrs = (attrs) => {
  const { blockBreak, block, html, ...rest } = attrs
  return rest
}

// ---- remote content is untrusted ---------------------------------------
// What a peer puts in the Y.Text becomes a Trix document in this browser.
// Trix expects documents made by its own parser, and throws while rendering
// one with a block attribute it does not know or an attachment whose
// filename is not a string. So what is read from Y is reduced to what Trix's
// configuration allows before a document is built from it.

// Attribute values that can run script when used as a URL. Browsers ignore
// whitespace and control characters inside the scheme.
const scriptUrl = (value) => {
  const v = String(value).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '').toLowerCase()
  if (/^(javascript|vbscript|livescript|mocha):/.test(v)) return true
  return v.startsWith('data:') && !/^data:(image\/(png|jpe?g|gif|webp|bmp|avif|x-icon)|audio\/|video\/)/.test(v)
}
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const ATTACHMENT_STRINGS = new Set(['content', 'contentType', 'filename', 'url', 'href', 'sgid', 'caption', 'presentation'])
const ATTACHMENT_NUMBERS = new Set(['filesize', 'width', 'height'])
const PIECE_STRINGS = new Set(['caption', 'presentation'])
/** Stands in for an embed that is not an attachment; keeps positions aligned. */
const BAD_EMBED = '\ufffd'

/** An attachment's attributes from an embed, or null if it is not one. */
const cleanAttachment = (embed) => {
  if (!isPlainObject(embed) || !isPlainObject(embed.attachment)) return null
  const out = {}
  for (const key of Object.keys(embed.attachment)) {
    const v = embed.attachment[key]
    if (ATTACHMENT_STRINGS.has(key)) {
      if (typeof v !== 'string') continue
      if ((key === 'url' || key === 'href') && scriptUrl(v)) continue
    } else if (ATTACHMENT_NUMBERS.has(key)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
    } else if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
    out[key] = v
  }
  return out
}

// Awareness state comes from peers too. The colour goes into a style
// declaration, so anything but a plain colour could add declarations of its
// own (a caret box that covers the page).
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{1,24}|(rgb|hsl)a?\([\d\s.,%/]{1,40}\))$/i
const cursorColor = (user) => (user && typeof user.color === 'string' && SAFE_COLOR.test(user.color) ? user.color : '#ffa500')
const cursorName = (user, clientID) => (user && typeof user.name === 'string' && user.name.length > 0 ? user.name.slice(0, 60) : String(clientID))

export class TrixBinding {
  /**
   * @param {Y.Text} ytext
   * @param {HTMLElement} element a <trix-editor>; one that Trix has not set
   *   up yet is bound when it fires trix-initialize (see `ready`)
   * @param {import('y-protocols/awareness').Awareness | null} [awareness]
   * @param {{ captureTimeout?: number, undoManager?: Y.UndoManager, cursors?: boolean, attachments?: boolean, Trix?: any, debug?: boolean }} [opts]
   *   undoManager: the app's own, in place of one made here.
   *   cursors: false leaves the other users' carets undrawn.
   *   attachments: false refuses files and shows attachments as U+FFFD.
   *   debug: after every step, compare the editor with Y and report the
   *   first step that leaves them different (slow; for tests)
   */
  constructor (ytext, element, awareness, opts = {}) {
    this.ytext = ytext
    this.doc = /** @type {Y.Doc} */ (ytext.doc)
    this.element = element
    this.awareness = awareness || null
    this.opts = opts
    this.destroyed = false
    this.attached = false
    /** Resolves with the binding once it is on the editor. */
    this.ready = new Promise((resolve) => { this.resolveReady = resolve })
    // Trix sets a <trix-editor> up when it is put in the page and says so
    // with trix-initialize. An element that is not set up yet (not in the
    // page, or Trix not loaded) is bound when it is.
    if (element.editorController) {
      this.attach()
    } else {
      this.onInitialize = () => { if (!this.destroyed && !this.attached) this.attach() }
      element.addEventListener('trix-initialize', this.onInitialize)
    }
  }

  attach () {
    const { ytext, element, opts } = this
    this.attached = true
    this.editor = element.editor
    this.controller = element.editorController
    this.composition = this.editor.composition
    const Trix = opts.Trix || globalThis.Trix
    this.T = Trix.models || Trix
    this.config = Trix.config
    // Before 2.1.4 Trix runs script found in an attachment's content, and
    // with this binding that content can come from any peer. 2.1.15 is the
    // oldest release without a published XSS advisory.
    const [major, minor, patch] = String(Trix.VERSION || '').split('.').map(Number)
    if (major === 2 && (minor < 1 || (minor === 1 && patch < 15))) {
      console.warn(`y-trix: Trix ${Trix.VERSION} has known XSS holes that a peer can reach through shared content; use 2.1.15 or later`)
    }
    /** Y embed object -> Trix Attachment, so rebuilt blocks keep their attachments. */
    this.attachments = new WeakMap()
    /** Attachments that a remote change replaced in place: they are changed to what their new embed says (see adoptReplaced). */
    this.adopted = new WeakSet()
    this.applyingRemote = false

    // After every render Trix runs its editor filters, and the one it ships
    // moves attachments marked as a gallery into a block of their own,
    // adding block breaks. After a local change that is part of the user's
    // edit and is written to Y with it. After a remote change it must not
    // run: every editor would add the same breaks at once, or, as Trix runs
    // it inside the remote change, add them here without Y hearing of it,
    // and every position after them would be off. A merge can leave gallery
    // attachments inside a text block; they stay there until someone edits.
    this.remoteDoc = null
    this.verifyTimer = null
    this.debug = !!opts.debug
    this.trace = []
    this.debugFailed = false
    this.origFilters = this.editor.filters.slice()
    this.editor.filters.splice(0, this.editor.filters.length, ...this.origFilters.map((filter) => (snapshot) =>
      (this.composition.document === this.remoteDoc ? undefined : filter.call(this.editor, snapshot))))

    // Take local changes synchronously as Trix makes them.
    const composition = this.composition
    const origSetDocument = composition.setDocument
    this.origSetDocument = origSetDocument
    composition.setDocument = (document) => {
      if (this.applyingRemote) return origSetDocument.call(composition, document)
      const range = this.safeSelectedRange()
      const before = composition.document.getLength()
      let result = origSetDocument.call(composition, document)
      // attachments: false. A file is refused when Trix asks (see
      // onFileAccept), but pasted HTML with an image in it, or the app's own
      // code, puts an attachment in without asking. It is taken out again
      // before anything is written, so this editor never adds one to the
      // shared document.
      if (this.noAttachments) {
        for (let n = 0; n < 1000; n++) {
          const attachment = composition.document.getAttachments()[0]
          if (!attachment) break
          const at = composition.document.getRangeOfAttachment(attachment)
          if (!at) break
          result = origSetDocument.call(composition, composition.document.removeTextAtRange(at))
        }
      }
      if (composition.document !== this.lastDoc) {
        const delta = composition.document.getLength() - before
        let hint
        if (range) hint = range[0] === range[1] ? range[0] + delta : range[0] + Math.max(0, delta)
        this.flushLocal(hint)
      }
      return result
    }

    // An attachment's attributes change in place (an upload finishing sets
    // url and href) without a new document.
    // (an attachment that changes while a remote change is applied is not the user's edit)
    this.onAttachmentEdit = (e) => { if (!this.applyingRemote) this.syncAttachment(e.attachment.attachment || e.attachment) }
    element.addEventListener('trix-attachment-edit', this.onAttachmentEdit)

    // Trix changes its document when Enter's beforeinput arrives, lets the
    // browser split the block in the DOM, and renders its own version on the
    // next animation frame. A key that arrives before that frame is read
    // against the browser's DOM and lands in the wrong place. Trix renders
    // at once for this on iOS only; do it everywhere, as soon as the browser
    // has finished its own change.
    this.onInput = (event) => {
      const input = this.controller.inputController
      if ((event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') && input && input.scheduledRender && input.render) input.render()
    }
    element.addEventListener('input', this.onInput)

    // While an input method is composing (Japanese, Chinese, Korean, and
    // most typing on Android), the browser owns the DOM around the caret and
    // any render by Trix ends the composition and commits the half-typed
    // text. So remote changes are held back until the composition is over.
    // See hold() and release().
    this.missingBreak = false
    this.held = false
    this.splitPending = false
    this.composing = false
    this.shadow = null
    this.shadowText = null
    // A composition is one undo step, however long the user takes over it:
    // undo takes the committed text out, and never brings back what was
    // half-typed on the way. (Yjs would start a step after every pause.)
    this.composeStep = false
    const endComposeStep = () => {
      if (!this.composeStep) return
      this.composeStep = false
      this.undoManager.captureTimeout = this.capturePause
    }
    this.onCompositionStart = () => {
      this.composing = true
      this.hold()
      if (!this.composeStep) {
        this.undoManager.stopCapturing()
        this.composeStep = true
        this.undoManager.captureTimeout = Infinity
      }
    }
    this.onCompositionEnd = () => {
      this.composing = false
      // after Trix (and Safari's late insertFromComposition) have finished
      setTimeout(() => { if (!this.composing) { if (!this.pressed) this.release(); endComposeStep() } }, 0)
    }
    this.onBlur = () => { if (!this.composing) { this.pressed = false; this.release(); endComposeStep() } }
    element.addEventListener('compositionstart', this.onCompositionStart)
    element.addEventListener('compositionend', this.onCompositionEnd)
    element.addEventListener('blur', this.onBlur)

    // While the mouse button is down in the editor the browser is making a
    // selection from the nodes that are there. A render by Trix replaces
    // them, and the selection comes out wrong (in Firefox it then starts at
    // the top of the document). So remote changes wait until the button is
    // up, as they do during a composition. (After dragging text there is no
    // mouseup: the drag's end says it.)
    this.pressed = false
    this.onMouseDown = (event) => {
      if (event.button !== 0) return
      this.pressed = true
      this.hold()
    }
    this.onMouseUp = () => {
      if (!this.pressed) return
      this.pressed = false
      // (after Trix has seen the event too)
      setTimeout(() => { if (!this.pressed && !this.composing) this.release() }, 0)
    }
    this.onMouseMove = (event) => { if (this.pressed && event.buttons === 0) this.onMouseUp() }
    // Where the caret is in a text field that has the focus (see
    // setDocumentRemote), noted when the user does something in it: after a
    // render by Trix the field itself can say 0.
    this.fieldCaret = null
    this.onFieldEvent = (event) => {
      const field = event.target
      try {
        if (field && field !== element && (field.nodeName === 'TEXTAREA' || field.nodeName === 'INPUT') && typeof field.selectionStart === 'number') {
          this.fieldCaret = { element: field, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection }
        }
      } catch (e) {}
    }
    for (const type of ['input', 'keyup', 'mouseup', 'focusin']) element.ownerDocument.addEventListener(type, this.onFieldEvent, true)
    element.addEventListener('mousedown', this.onMouseDown)
    this.win = element.ownerDocument.defaultView
    // (and if the button came up where no mouseup says so: the next move without it, or the window losing the focus)
    for (const type of ['mouseup', 'dragend', 'drop', 'blur']) this.win.addEventListener(type, this.onMouseUp, true)
    this.win.addEventListener('mousemove', this.onMouseMove, true)

    // opts.undoManager: the app's own Y.UndoManager (one for several
    // editors, say). It is told to track this binding, and is the app's to
    // destroy.
    this.ownsUndo = !opts.undoManager
    this.undoManager = opts.undoManager || new Y.UndoManager(ytext, {
      trackedOrigins: new Set([this]),
      captureTimeout: opts.captureTimeout ?? 500
    })
    if (!this.ownsUndo) this.undoManager.addTrackedOrigin(this)
    this.capturePause = this.undoManager.captureTimeout
    this.onStackAdded = (e) => {
      e.stackItem.meta.set('selection', this.selectionToRelative())
      this.updateActions()
    }
    this.onStackPopped = (e) => {
      const sel = e.stackItem.meta.get('selection')
      if (sel && this.isFocused()) this.restoreSelection(sel)
      this.updateActions()
    }
    this.undoManager.on('stack-item-added', this.onStackAdded)
    this.undoManager.on('stack-item-popped', this.onStackPopped)
    this.patchUndo()

    // opts.attachments === false: this editor takes no files, and an
    // attachment in the shared document (anyone can put one there) is shown
    // as U+FFFD, like any other embed it does not show.
    this.noAttachments = opts.attachments === false
    this.onFileAccept = (event) => { if (this.noAttachments) event.preventDefault() }
    element.addEventListener('trix-file-accept', this.onFileAccept)

    this.onYChange = (event, tr) => {
      if (this.destroyed) return
      this.scheduleVerify()
      if (tr.origin === this) return
      if (this.held) return // shown when the composition ends
      const before = this.debug ? this.debugState() : ''
      try {
        this.applyRemote(event)
      } catch (e) {
        // Whatever a peer sent, keep going: show what Y holds.
        console.error('y-trix: applying a remote change failed', e)
        try { this.renderAll() } catch (e2) { console.error('y-trix: redraw failed', e2) }
      }
      if (this.debug) {
        // what the transaction added and deleted, read from the items themselves
        const items = []
        for (let item = /** @type {any} */ (ytext)._start; item !== null; item = item.right) {
          const added = item.id.clock >= (tr.beforeState.get(item.id.client) || 0)
          const deleted = Y.isDeleted(tr.deleteSet, item.id)
          if (added || deleted) items.push(`${added ? '+' : ''}${deleted ? '-' : ''}${item.deleted ? 'x' : ''}${item.id.client % 1000}:${item.id.clock}:${item.length}:${JSON.stringify(item.content.str ?? item.content.key ?? 'embed')}`)
        }
        this.check('remote', `${before} origin ${String(tr.origin && tr.origin.constructor ? tr.origin.constructor.name : tr.origin)}${tr.local ? ' local' : ''} delta ${JSON.stringify(event.delta).slice(0, 600)} items ${items.join(' ').slice(0, 600)}`)
      }
    }
    ytext.observe(this.onYChange)

    // Initial state: Y wins if it has content, otherwise Y takes the editor's.
    this.lastDoc = composition.document
    if (ytext.length > 0) {
      this.renderAll()
    } else if (!composition.document.isEmpty()) {
      this.flushLocal()
    }

    if (this.awareness) this.setupAwareness()
    this.resolveReady(this)
  }

  isFocused () {
    return this.element.ownerDocument.activeElement === this.element
  }

  safeSelectedRange () {
    try {
      // After a mouse press Trix stops following the selection until the
      // mouse moves or a fifth of a second has passed. What it says then is
      // where the caret was before the click, so ask the page.
      const manager = this.controller.selectionManager
      if (manager && manager.paused && !manager.lockedLocationRange) {
        const now = manager.getLocationRange({ strict: false })
        if (now) return this.composition.document.rangeFromLocationRange(now)
      }
      return this.composition.getSelectedRange() || null
    } catch (e) { return null }
  }

  // ---- local Trix -> Yjs ----------------------------------------------------

  /**
   * Write the difference between the last synced document and the current
   * one into Yjs.
   * @param {number} [hint] caret position in the new document, used to place
   *   an ambiguous edit where the user made it
   */
  flushLocal (hint) {
    if (!this.debug) { this.writeLocal(hint); this.frozenRange(); return }
    const before = this.debugState()
    this.writeLocal(hint)
    this.frozenRange()
    this.check('local', before + ' hint ' + hint)
  }

  debugState () {
    return `[y ${this.ytext.length} editor ${this.composition.document.getLength()} last ${this.lastDoc.getLength()}${this.missingBreak ? ' missingBreak' : ''}${this.held ? ' held' : ''}${this.controller.handlingInput ? ' input' : ''}${this.applyingRemote ? ' remote' : ''}]`
  }

  /** opts.debug: the editor has to show what Y holds after every step. */
  check (where, info) {
    this.trace.push(`${where} ${info} -> ${this.debugState()}`)
    if (this.trace.length > 30) this.trace.shift()
    if (this.debugFailed || this.destroyed || this.held || this.applyingRemote || this.composition.document !== this.lastDoc) return
    const want = new this.T.Document(this.runsToBlocks(deltaRuns(this.ytext.toDelta())))
    const a = docSig(want)
    const b = docSig(this.composition.document)
    if (a === b || (this.ytext.length === 0 && this.composition.document.isEmpty())) return
    this.debugFailed = true
    let k = 0
    while (k < a.length && a[k] === b[k]) k++
    console.error(`y-trix debug: after a ${where} step the editor does not show what Y holds\nY:      ${a.slice(Math.max(0, k - 100), k + 160)}\neditor: ${b.slice(Math.max(0, k - 100), k + 160)}\n${this.trace.join('\n')}`)
  }

  writeLocal (hint) {
    const next = this.composition.document
    const prev = this.lastDoc
    this.lastDoc = next
    if (this.missingBreak) {
      // The editor's final break is not in Y yet (see noteTrailingBreak).
      this.missingBreak = false
      const text = this.wtext
      this.wdoc.transact(() => text.insert(text.length, '\n', { blockBreak: true }), this)
    }
    const b = next.getBlocks()
    if (this.wtext.length === 0) {
      // Y holds nothing yet (an empty Trix document has one empty block).
      if (next.isEmpty()) return
      this.wdoc.transact(() => this.applyRuns(0, [], trixRuns(b), hint), this)
      return
    }
    if (prev === next) return
    const a = prev.getBlocks()
    const min = Math.min(a.length, b.length)
    let p = 0
    let base = 0
    while (p < min && a[p] === b[p]) base += a[p++].getLength()
    let s = 0
    while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
    const aRuns = trixRuns(a.slice(p, a.length - s))
    const bRuns = trixRuns(b.slice(p, b.length - s))
    // Half of a surrogate pair on its own (an emoji split by an edit at a
    // position inside it, which the API allows) cannot be sent: Yjs would
    // give the other editors U+FFFD and keep the half here. Write U+FFFD to
    // begin with, and show it here too.
    let split = false
    for (const r of bRuns) {
      if (r.embed || !SURROGATE.test(r.str)) continue
      const fixed = r.str.replace(LONE_SURROGATE, '\ufffd')
      if (fixed !== r.str) { r.str = fixed; split = true }
    }
    this.wroteMore = false
    const clock = Y.getState(this.wdoc.store, this.wdoc.clientID)
    this.wdoc.transact(() => this.applyRuns(base, aRuns, bRuns, hint === undefined ? undefined : hint - base), this)
    // Text typed inside a run of one format is written as text and nothing
    // else, and lands as written. Anywhere else Yjs writes format markers
    // beside it (to keep what is there from applying to the new text), and
    // with other people's changes around, those can leave the neighbours
    // reading differently. So: did this write make a format marker?
    if (!this.wroteMore) {
      const mine = this.wdoc.store.clients.get(this.wdoc.clientID) || []
      for (let k = mine.length - 1; k >= 0 && mine[k].id.clock >= clock; k--) {
        if (mine[k].content instanceof Y.ContentFormat) { this.wroteMore = true; break }
      }
    }
    // Yjs does not always leave a format as it was written (a block
    // attribute taken off a break can still be there afterwards). The
    // editor has to show what Y holds, so read the changed blocks back.
    // (Not after typing that wrote text alone: reading Y costs time in a
    // long document.)
    if (!split && this.wroteMore) {
      const mine = b.slice(p, b.length - s)
      const len = mine.reduce((n, block) => n + block.getLength(), 0)
      const theirs = this.runsToBlocks(sliceRuns(deltaRuns(this.wtext.toDelta()), base, base + len))
      if (blocksSig(theirs) !== blocksSig(mine)) split = true
    }
    if (split) {
      // (not while an input method is composing: a render would end the
      // composition, so the editor shows it when the composition is over)
      if (this.held) this.splitPending = true
      else this.showSplit()
    }
  }

  /** Show what Y holds after a local change that it took differently. */
  showSplit () {
    this.splitPending = false
    const range = this.isFocused() ? this.safeSelectedRange() : null
    this.setDocumentRemote(new this.T.Document(this.runsToBlocks(deltaRuns(this.ytext.toDelta()))), range)
  }

  /**
   * Change the Y text at [base, base + |aRuns|), which holds aRuns, into bRuns.
   */
  applyRuns (base, aRuns, bRuns, cursor) {
    const ytext = this.wtext
    const seen = new Map()
    const aStr = runsString(aRuns, seen)
    const bStr = runsString(bRuns, seen)
    const aChars = charIndex(aRuns)
    const bChars = charIndex(bRuns)
    const ops = textDiff(aStr, bStr, cursor !== undefined && cursor >= 0 && cursor <= bStr.length ? cursor : undefined)
    // Characters kept by the diff: [aIndex, bIndex] pairs.
    const kept = []
    let ai = 0
    let bi = 0
    const withB = []
    for (const op of ops) {
      while (ai < op.index) kept.push([ai++, bi++])
      withB.push({ ...op, bIndex: bi })
      ai += op.remove
      bi += op.insert.length
    }
    while (ai < aStr.length) kept.push([ai++, bi++])

    // Text: right to left so earlier indices stay valid.
    for (let k = withB.length - 1; k >= 0; k--) {
      const { index, remove, insert, bIndex } = withB[k]
      if (remove > 0) { ytext.delete(base + index, remove); this.wroteMore = true }
      if (insert.length > 0) this.insertRuns(base + index, bRuns, bChars, bIndex, bIndex + insert.length)
    }

    // Attributes of kept characters. Index in the new text is the b index.
    let k = 0
    while (k < kept.length) {
      const [ak, bk] = kept[k]
      const ar = aChars[ak]
      const br = bChars[bk]
      if (!!ar.embed !== !!br.embed || (ar.embed && !equal(ar.embed, br.embed))) {
        ytext.delete(base + bk, 1)
        this.insertRuns(base + bk, bRuns, bChars, bk, bk + 1)
        this.wroteMore = true
        k++
        continue
      }
      const patch = attrPatch(ar.attrs, br.attrs)
      if (isEmptyObject(patch)) { k++; continue }
      // extend over following kept characters needing the same patch
      let n = 1
      while (k + n < kept.length && kept[k + n][1] === bk + n && !aChars[kept[k + n][0]].embed && !bChars[bk + n].embed &&
        equal(attrPatch(aChars[kept[k + n][0]].attrs, bChars[bk + n].attrs), patch)) n++
      ytext.format(base + bk, n, patch)
      this.wroteMore = true
      k += n
    }
  }

  /** Insert the characters [from, to) of bRuns at Y index `at`. */
  insertRuns (at, bRuns, bChars, from, to) {
    let i = from
    while (i < to) {
      const run = bChars[i]
      if (run.embed) {
        const embed = { attachment: { ...run.embed.attachment } }
        if (run.attachment) this.attachments.set(embed, run.attachment)
        this.wtext.insertEmbed(at, embed, { ...run.attrs })
        this.wroteMore = true
        at++; i++
        continue
      }
      let j = i
      while (j < to && bChars[j] === run) j++
      // offset of i inside its run
      let start = i
      while (start > 0 && bChars[start - 1] === run) start--
      const str = run.str.slice(i - start, j - start)
      this.wtext.insert(at, str, { ...run.attrs })
      // A line break is written with its own attributes next to others'
      // (a block break beside a soft one), and Yjs can leave the ones around
      // it reading differently. Y is read back after it (see writeLocal).
      if (str.includes('\n')) this.wroteMore = true
      at += str.length
      i = j
    }
  }

  syncAttachment (attachment) {
    if (!attachment) return
    this.release()
    const document = this.composition.document
    if (document !== this.lastDoc) this.flushLocal()
    let range
    try { range = document.getRangeOfAttachment(attachment) } catch (e) { return }
    if (!range) return
    const pos = range[0]
    const [op] = sliceRuns(deltaRuns(this.ytext.toDelta()), pos, pos + 1)
    if (!op || !op.embed) return
    const had = op.embed.attachment || {}
    const now = attachment.getAttributes()
    if (fromY.has(attachment) && had.width === undefined && had.height === undefined && now.width !== undefined && now.height !== undefined) {
      measured.set(attachment, { width: now.width, height: now.height })
    }
    const attrs = sharedAttrs(attachment)
    if (equal(op.embed.attachment, attrs)) return
    const piece = document.getAttachmentPieceForAttachment(attachment)
    this.doc.transact(() => {
      const embed = { attachment: { ...attrs } }
      this.attachments.set(embed, attachment)
      this.ytext.delete(pos, 1)
      this.ytext.insertEmbed(pos, embed, piece ? sharedPieceAttrs(piece) : op.attrs)
    }, this)
  }

  // ---- holding remote changes during a composition --------------------------

  /** Where local changes are written: the shadow while holding, else Y. */
  get wtext () { return this.held ? this.shadowText : this.ytext }
  get wdoc () { return this.held ? this.shadow : this.doc }

  /**
   * A second Y.Doc that always holds exactly what the editor shows. Outside a
   * composition it follows the real doc update by update. During one it
   * stops following, so the editor and the shadow behave like a peer that is
   * offline for a moment: local changes are written to the shadow, in the
   * editor's own positions, and sent on to the real doc, where Yjs merges
   * them with whatever arrived meanwhile.
   */
  ensureShadow () {
    if (this.shadow) return
    this.shadow = new Y.Doc({ gc: this.doc.gc })
    Y.applyUpdate(this.shadow, Y.encodeStateAsUpdate(this.doc), 'sync')
    const item = /** @type {any} */ (this.ytext)._item
    this.shadowText = item
      ? /** @type {any} */ (Y.getItem(/** @type {any} */ (this.shadow).store, item.id)).content.type
      : this.shadow.getText(Y.findRootTypeKey(this.ytext))
    this.onDocUpdate = (update) => { if (!this.held) Y.applyUpdate(this.shadow, update, 'sync') }
    this.doc.on('update', this.onDocUpdate)
    this.shadow.on('update', (update, origin) => { if (origin === this) Y.applyUpdate(this.doc, update, this) })
  }

  hold () {
    if (this.held) return
    if (this.composition.document !== this.lastDoc) this.flushLocal()
    try { this.ensureShadow() } catch (e) { console.error('y-trix: cannot hold remote changes', e); return }
    this.held = true
  }

  /** Show what arrived while holding. */
  release () {
    if (!this.held) return
    if (this.composition.document !== this.lastDoc) this.flushLocal()
    this.held = false
    let event = null
    // (the delta is worked out now: once the transaction is over Yjs has
    // thrown the deleted items away, and it would say nothing was deleted)
    const observe = (e) => { event = e; void e.delta }
    this.shadowText.observe(observe)
    try {
      Y.applyUpdate(this.shadow, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.shadow)), 'sync')
    } finally {
      this.shadowText.unobserve(observe)
    }
    if (event) {
      try {
        // the event's delta is in the shadow's positions, which are the editor's
        this.applyRemote(event)
      } catch (e) {
        console.error('y-trix: applying held remote changes failed', e)
        try { this.renderAll() } catch (e2) { console.error('y-trix: redraw failed', e2) }
      }
    }
    if (this.splitPending) {
      try { this.showSplit() } catch (e) { console.error('y-trix: redraw failed', e) }
    }
  }

  // ---- remote Yjs -> Trix ---------------------------------------------------

  /** Build Trix blocks from runs. Text without a closing block break becomes a block. */
  runsToBlocks (runs) {
    const { Block, Text, StringPiece, AttachmentPiece, Attachment } = this.T
    const blocks = []
    let pieces = []
    const close = (attrs) => {
      pieces.push(new StringPiece('\n', { ...this.cleanTextAttrs(attrs), blockBreak: true }))
      const block = this.cleanBlockAttrs(attrs.block)
      blocks.push(new Block(new Text(pieces), block, this.cleanHtmlAttrs(attrs.html, block)))
      pieces = []
    }
    // Adjacent string runs with equal attributes become one piece, as Trix
    // itself keeps them; Yjs may split them where a format marker sits.
    let text = ''
    let textAttrsOf = null
    const flushText = () => {
      if (text) pieces.push(new StringPiece(text, textAttrsOf))
      text = ''
      textAttrsOf = null
    }
    const addText = (str, attrs) => {
      if (text && !equal(attrs, textAttrsOf)) flushText()
      text += str
      textAttrsOf = attrs
    }
    for (const r of runs) {
      if (r.embed) {
        let attachment = this.noAttachments ? null : cleanAttachment(r.embed)
        if (attachment === null) { addText(BAD_EMBED, {}); continue }
        flushText()
        // Trix keeps a link on an attachment in the attachment itself: given
        // a piece with href, it moves the href over and says the attachment
        // was edited. Every editor would then write that edit, replacing the
        // embed, and the attachment would be there once per editor. So make
        // the attachment that way to begin with.
        const pieceAttrs = this.cleanTextAttrs(r.attrs, true)
        if (typeof pieceAttrs.href === 'string') {
          if (attachment.href === undefined) attachment = { ...attachment, href: pieceAttrs.href }
          delete pieceAttrs.href
        }
        let att = this.attachments.get(r.embed)
        if (att && this.adopted.has(att)) {
          this.adopted.delete(att)
          if (!equal(sharedAttrs(att), attachment)) this.changeAttachment(att, attachment)
        }
        // Attachments change in place, so a remembered one can be newer than
        // its embed (undo brings the old embed back). Then make one from the
        // embed.
        if (!att || !equal(sharedAttrs(att), attachment)) {
          att = new Attachment(attachment)
          fromY.add(att)
          this.attachments.set(r.embed, att)
        }
        pieces.push(new AttachmentPiece(att, pieceAttrs))
        continue
      }
      // Block attributes belong on block breaks only. Concurrent edits (and
      // undo restoring format markers) can leave them on other characters;
      // those are ignored there.
      const plain = this.cleanTextAttrs(r.attrs)
      if (!r.attrs.blockBreak) { addText(r.str, plain); continue }
      for (const ch of r.str) {
        if (ch === '\n' || ch === '\r') { flushText(); close(r.attrs) } else addText(ch, plain)
      }
    }
    flushText()
    if (pieces.length > 0) blocks.push(new Block(new Text(pieces)))
    return blocks
  }

  /**
   * An attachment that someone replaced by another in the same place (that
   * is how a changed attribute travels: an upload finishing) stays the
   * object it is in this editor and is given the new attributes. With a new
   * object, a caption this user is typing on it would be lost when they
   * finish, and Trix throws there.
   * @param {any[]} delta a change from Y that the editor does not show yet
   */
  adoptReplaced (delta) {
    try {
      let at = 0 // in the document the editor shows
      for (let i = 0; i < delta.length; i++) {
        const op = delta[i]
        if (op.retain !== undefined) { at += op.retain; continue }
        if (op.delete === undefined) continue
        const put = [delta[i - 1], delta[i + 1]].find((o) => o && o.insert !== undefined && typeof o.insert !== 'string' && !this.attachments.has(o.insert))
        if (op.delete === 1 && put && at < this.lastDoc.getLength()) {
          const piece = this.lastDoc.getPieceAtPosition(at)
          if (piece && piece.attachment) {
            this.attachments.set(put.insert, piece.attachment)
            this.adopted.add(piece.attachment)
          }
        }
        at += op.delete
      }
    } catch (e) {}
  }

  /** Give an attachment the attributes of its embed, in place. */
  changeAttachment (att, attrs) {
    // (what this editor measured stays, if the embed still has no size)
    const own = measured.get(att)
    const want = own && attrs.width === undefined && attrs.height === undefined ? { ...attrs, ...own } : attrs
    const flag = this.applyingRemote
    this.applyingRemote = true
    try {
      att.setAttributes(want)
      // (an attribute that is gone: Trix has no call for that, so take it
      // out and tell Trix's views as setAttributes does)
      let hash = att.attributes
      for (const key of Object.keys(att.getAttributes())) if (!(key in want)) hash = hash.remove(key)
      if (hash !== att.attributes) {
        att.attributes = hash
        att.didChangeAttributes()
        if (att.previewDelegate && att.previewDelegate.attachmentDidChangeAttributes) att.previewDelegate.attachmentDidChangeAttributes(att)
        if (att.delegate && att.delegate.attachmentDidChangeAttributes) att.delegate.attachmentDidChangeAttributes(att)
      }
    } catch (e) {} finally {
      this.applyingRemote = flag
    }
  }

  /**
   * Text attributes from Y that Trix is configured for, with values of the
   * kind Trix stores: true, or a string or number (href). Block attributes
   * are dropped; they belong on block breaks only.
   */
  cleanTextAttrs (attrs, attachment = false) {
    const known = this.config.textAttributes
    const out = {}
    for (const key of Object.keys(attrs)) {
      if (key === 'blockBreak' || key === 'block' || key === 'html' || key === FROZEN) continue
      const v = attrs[key]
      if (attachment && PIECE_STRINGS.has(key)) { if (typeof v === 'string') out[key] = v; continue }
      if (!Object.prototype.hasOwnProperty.call(known, key)) continue
      if (v !== true && typeof v !== 'string' && typeof v !== 'number') continue
      if (key === 'href' && (typeof v !== 'string' || scriptUrl(v))) continue
      out[key] = v
    }
    return out
  }

  /** The block attributes Trix is configured for, in order. */
  cleanBlockAttrs (block) {
    if (!Array.isArray(block)) return []
    const known = this.config.blockAttributes
    return block.filter((name) => typeof name === 'string' && name !== 'default' && Object.prototype.hasOwnProperty.call(known, name))
  }

  /** HTML attributes that one of the block's attributes allows, as strings. */
  cleanHtmlAttrs (html, block) {
    const out = {}
    if (!isPlainObject(html)) return out
    const allowed = new Set(block.flatMap((name) => this.config.blockAttributes[name].htmlAttributes || []))
    for (const key of Object.keys(html)) {
      if (allowed.has(key) && (typeof html[key] === 'string' || typeof html[key] === 'number')) out[key] = String(html[key])
    }
    return out
  }

  /**
   * Two things another client can put in Y that this editor cannot show as
   * they are, mended in Y:
   *
   * Trix turns "\r\n" into "\n" in every string it stores, which would
   * leave its document shorter than the Y.Text. The "\r" of each pair is
   * deleted. Only deleting keeps this safe when every editor does it at
   * once. (A "\r" on its own becomes "\n" in Trix, the same length, and
   * stays.)
   *
   * Half of a surrogate pair on its own reaches every other Y.Doc as
   * U+FFFD, because updates travel as UTF-8, while the doc it was written
   * to keeps the half. Only that doc can see it, so only the editors on it
   * replace it with U+FFFD.
   * @return {boolean} whether Y changed
   */
  normalizeY () {
    const fixes = [] // [position, replacement or null, attributes]
    let pos = 0
    const delta = this.ytext.toDelta()
    delta.forEach((op, i) => {
      if (typeof op.insert !== 'string') { pos += 1; return }
      const str = op.insert
      if (str.includes('\r')) {
        for (let k = 0; k < str.length; k++) {
          if (str[k] !== '\r') continue
          const next = k + 1 < str.length ? str[k + 1] : (delta[i + 1] && typeof delta[i + 1].insert === 'string' ? delta[i + 1].insert[0] : '')
          if (next === '\n') fixes.push([pos + k, null])
        }
      }
      if (SURROGATE.test(str)) {
        LONE_SURROGATE.lastIndex = 0
        for (let m = LONE_SURROGATE.exec(str); m !== null; m = LONE_SURROGATE.exec(str)) fixes.push([pos + m.index, '\ufffd', op.attributes || {}])
      }
      pos += str.length
    })
    if (fixes.length === 0) return false
    fixes.sort((a, b) => b[0] - a[0])
    this.doc.transact(() => {
      for (const [at, put, attrs] of fixes) {
        this.ytext.delete(at, 1)
        if (put !== null) this.ytext.insert(at, put, { ...attrs })
      }
    }, this)
    return true
  }

  /**
   * Local changes are written and remote ones applied piece by piece, which
   * is fast and keeps the caret where it is. Whatever that leaves, the
   * editor has to end up showing what Y holds: a document one character
   * longer than Y puts every later edit in the wrong place. So once things
   * are quiet, compare the editor with Y read from scratch, and redraw if
   * they differ.
   */
  scheduleVerify () {
    if (this.verifyTimer) clearTimeout(this.verifyTimer)
    this.verifyTimer = setTimeout(() => {
      this.verifyTimer = null
      if (this.destroyed) return
      if (this.held || this.composing || this.applyingRemote || this.controller.handlingInput) { this.scheduleVerify(); return }
      if (this.composition.document !== this.lastDoc) this.flushLocal()
      if (this.ytext.length === 0) return
      const want = new this.T.Document(this.runsToBlocks(deltaRuns(this.ytext.toDelta())))
      const a = docSig(want)
      const b = docSig(this.composition.document)
      if (a === b) return
      let k = 0
      while (k < a.length && a[k] === b[k]) k++
      console.warn(`y-trix: the editor did not show what Y holds; redrawn (Y: ${a.slice(Math.max(0, k - 60), k + 60)} | editor: ${b.slice(Math.max(0, k - 60), k + 60)})`)
      const range = this.isFocused() ? this.safeSelectedRange() : null
      this.setDocumentRemote(want, range)
      this.noteTrailingBreak()
    }, 250)
  }

  renderAll () {
    if (this.held) {
      // everything is about to be shown
      this.held = false
      Y.applyUpdate(this.shadow, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.shadow)), 'sync')
    }
    this.normalizeY()
    const blocks = this.runsToBlocks(deltaRuns(this.ytext.toDelta()))
    this.setDocumentRemote(new this.T.Document(blocks))
    this.noteTrailingBreak()
  }

  applyRemote (event) {
    if (this.composition.document !== this.lastDoc) {
      console.warn('y-trix: unsynced local change while applying a remote update')
    }
    // (a selection held for a toolbar dialog that has not been seen yet: where it is after this change)
    this.frozenRange(event.delta)
    if (this.composition.document === this.lastDoc) this.adoptReplaced(event.delta)
    // Changed range, in old and new coordinates.
    let oldPos = 0
    let newPos = 0
    let start = -1
    let oldEnd = 0
    let newEnd = 0
    if (this.normalizeY()) {
      // Y no longer matches the event; show all of it.
      this.renderAll()
      this.renderCursors()
      return
    }
    for (const op of event.delta) {
      if (op.retain !== undefined && !op.attributes) {
        oldPos += op.retain; newPos += op.retain
        continue
      }
      if (start < 0) start = newPos
      if (op.retain !== undefined) { oldPos += op.retain; newPos += op.retain } else if (op.delete !== undefined) oldPos += op.delete
      else newPos += typeof op.insert === 'string' ? op.insert.length : 1
      oldEnd = oldPos; newEnd = newPos
    }
    const newLen = this.ytext.length
    if (start < 0) {
      // Nothing changed, says Yjs. It leaves an embed that is not an object
      // (a number, which the API accepts) out of the delta, though, and a
      // format marker it deleted as redundant can change what a character
      // reads as. This is rare, so look at everything.
      const want = new this.T.Document(this.runsToBlocks(deltaRuns(this.ytext.toDelta())))
      if (docSig(want) === docSig(this.lastDoc)) return
      const same = newLen + (this.missingBreak ? 1 : 0) === this.lastDoc.getLength()
      this.setDocumentRemote(want, same && this.isFocused() ? this.safeSelectedRange() : null)
      this.noteTrailingBreak()
      this.renderCursors()
      return
    }
    const old = this.lastDoc
    const oldLen = newLen - (newEnd - start) + (oldEnd - start)
    const blocks = old.getBlocks()
    // The caret in old coordinates, carried through the change. A remote
    // insert at the caret goes after it, as with a live DOM range.
    const range = this.isFocused() ? this.safeSelectedRange() : null
    let selAfter = range ? range.map((i) => mapIndex(event.delta, i)) : null
    let doc
    if (oldLen + (this.missingBreak ? 1 : 0) !== old.getLength() || blocks.length === 0) {
      // Y and the editor were not aligned (the first sync into an empty
      // editor): rebuild everything.
      doc = new this.T.Document(this.runsToBlocks(deltaRuns(this.ytext.toDelta())))
      selAfter = null
    } else {
      // Blocks touching [start, oldEnd], the character at oldEnd included so
      // that deleting a break also rebuilds the block it merged into.
      let bi = 0
      let pos = 0
      while (bi < blocks.length - 1 && pos + blocks[bi].getLength() <= start) pos += blocks[bi++].getLength()
      const from = pos
      let bj = bi
      let end = pos + blocks[bj].getLength()
      while (bj < blocks.length - 1 && end <= oldEnd) end += blocks[++bj].getLength()
      const to = end + (newLen - oldLen)
      const runs = sliceRuns(deltaRuns(this.ytext.toDelta()), from, to)
      const rebuilt = this.runsToBlocks(runs)
      doc = new this.T.Document(blocks.slice(0, bi).concat(rebuilt, blocks.slice(bj + 1)))
    }
    this.setDocumentRemote(doc, selAfter)
    this.noteTrailingBreak()
    this.renderCursors()
  }

  /**
   * The range Trix holds as selected while a toolbar dialog is open, in Y
   * positions, or null. Trix keeps it as fixed positions; here it is kept as
   * Yjs positions from the first time it is seen, so that it stays with its
   * text through other people's changes (see setDocumentRemote).
   * @param {any[]} [delta] a change Y has had that the editor does not show yet
   */
  frozenRange (delta) {
    const manager = this.controller.selectionManager
    let locked = manager ? manager.lockedLocationRange : null
    // (Trix says the selection is held only after it has marked the text,
    // and it locks the selection for a moment whenever it renders)
    // (so look at the block the range starts in, and no further: this runs at every change)
    if (locked && !this.controller.selectionFrozen) {
      let marked = false
      try {
        const block = this.composition.document.getBlockAtIndex(locked[0].index)
        marked = !!block && block.text.getPieces().some((piece) => piece.getAttribute(FROZEN))
      } catch (e) {}
      if (!marked) locked = null
    }
    if (!locked || this.held) { this.frozen = null; return null }
    const clamp = (i) => Math.max(0, Math.min(i, this.ytext.length))
    if (!this.frozen || this.frozen.locked !== locked) {
      let range
      try { range = this.lastDoc.rangeFromLocationRange(locked) } catch (e) { return null }
      if (!range) return null
      if (delta) range = range.map((i) => mapIndex(delta, i))
      // (the start stays after what is typed just before it, the end before what is typed just after)
      this.frozen = { locked, rel: [Y.createRelativePositionFromTypeIndex(this.ytext, clamp(range[0]), 0), Y.createRelativePositionFromTypeIndex(this.ytext, clamp(range[1]), -1)] }
    }
    const abs = this.frozen.rel.map((rel) => Y.createAbsolutePositionFromRelativePosition(rel, this.doc))
    if (abs.some((a) => a === null || a.type !== this.ytext)) return null
    return [abs[0].index, Math.max(abs[0].index, abs[1].index)]
  }

  /**
   * Show a document built from Y without treating it as a local change, and
   * without disturbing the page selection when this editor is not focused.
   * @param {any} document
   * @param {[number, number]|null} [sel] selection to set when focused
   */
  setDocumentRemote (document, sel) {
    const win = this.element.ownerDocument.defaultView
    const domSel = win.getSelection()
    const focused = this.isFocused()
    const saved = !focused && domSel.rangeCount > 0 ? domSel.getRangeAt(0).cloneRange() : null
    // (and which way it runs: a range alone would turn a selection made backwards around)
    const ends = saved ? [domSel.anchorNode, domSel.anchorOffset, domSel.focusNode, domSel.focusOffset] : null
    // A selection made from its end to its start (Shift and the left arrow):
    // Trix sets a range, which runs forwards, and the next Shift and arrow
    // would then move the wrong end.
    let backwards = false
    try {
      if (focused && domSel.rangeCount > 0 && !domSel.isCollapsed && domSel.anchorNode && domSel.focusNode) {
        const order = domSel.anchorNode.ownerDocument.createRange()
        order.setStart(domSel.focusNode, domSel.focusOffset)
        order.setEnd(domSel.anchorNode, domSel.anchorOffset)
        backwards = !order.collapsed
      }
    } catch (e) {}
    const active = this.element.ownerDocument.activeElement
    // The focus in a text field (an attachment's caption, or a field
    // elsewhere on the page): its selection is the field's own, not a range
    // in the page. Putting a page range back takes the keyboard from the
    // field in Safari, and what is typed next goes nowhere.
    const field = this.fieldCaret && this.fieldCaret.element === active && !focused ? this.fieldCaret : null
    // Trix does not redraw while an attachment is selected for editing, so
    // nothing anyone else did would show until this user clicked away.
    // Deselect it, unless they are typing its caption.
    if (this.composition.editingAttachment) {
      const field = this.element.ownerDocument.activeElement
      const inCaption = field !== null && field.nodeName === 'TEXTAREA' && this.element.contains(field)
      if (!inCaption) this.composition.stopEditingAttachment()
    }
    // What the user is looking at stays where it is on the screen (see scrollAnchors).
    const anchors = this.scrollAnchors()
    // A format switched on or off with nothing selected, for what is typed
    // next, is not in the document yet. Trix forgets it when the selection
    // is set again, so it is put back afterwards.
    const pending = this.pendingAttributes()
    // A selection held for a toolbar dialog goes where its text went, with
    // its highlight (blocks made from Y have none).
    const frozen = this.frozenRange()
    if (frozen) {
      const end = Math.min(frozen[1], document.getLength())
      try { if (end > frozen[0]) document = document.addAttributeAtRange(FROZEN, true, [frozen[0], end]) } catch (e) {}
    }
    this.applyingRemote = true
    // (noted first: Trix can render, and run its filters, inside setDocument)
    this.remoteDoc = document
    try {
      this.origSetDocument.call(this.composition, document)
    } finally {
      this.applyingRemote = false
    }
    this.lastDoc = this.composition.document
    if (frozen && this.frozen) {
      try {
        const locked = this.lastDoc.locationRangeFromRange([Math.min(frozen[0], this.lastDoc.getLength()), Math.min(frozen[1], this.lastDoc.getLength())])
        this.controller.selectionManager.lockedLocationRange = locked
        this.frozen.locked = locked
      } catch (e) {}
    }
    // Trix skips rendering while it handles an input event and renders after
    // only if its own input code asked. Undo from the keyboard lands here
    // inside such an event, so render now, as Trix's own undo does.
    if (this.controller.handlingInput) this.controller.render()
    if (focused && sel) {
      try { this.editor.setSelectedRange(sel) } catch (e) {}
      try {
        if (backwards && domSel.rangeCount > 0 && !domSel.isCollapsed) {
          const range = domSel.getRangeAt(0)
          domSel.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)
        }
      } catch (e) {}
    } else if (field && field.element === active && active.isConnected) {
      if (this.element.ownerDocument.activeElement !== active) active.focus({ preventScroll: true })
      try { active.setSelectionRange(Math.min(field.start, active.value.length), Math.min(field.end, active.value.length), field.direction || 'none') } catch (e) {}
    } else if (!focused) {
      if (saved && (domSel.rangeCount === 0 || !rangesEqual(domSel.getRangeAt(0), saved))) {
        domSel.removeAllRanges()
        try {
          if (!ends[0].isConnected || !ends[2].isConnected) throw new Error('gone')
          domSel.setBaseAndExtent(ends[0], ends[1], ends[2], ends[3])
        } catch (e) {
          domSel.addRange(saved)
        }
      }
      if (active && this.element.ownerDocument.activeElement !== active && active.focus) active.focus({ preventScroll: true })
    }
    if (pending) {
      try {
        const range = this.composition.getSelectedRange()
        if (range && range[0] === range[1]) {
          const attrs = { ...this.composition.currentAttributes }
          for (const key of Object.keys(pending)) { if (pending[key] === null) delete attrs[key]; else attrs[key] = pending[key] }
          this.composition.currentAttributes = attrs
          this.composition.notifyDelegateOfCurrentAttributesChange()
        }
      } catch (e) {}
    }
    if (anchors) this.keepScroll(anchors)
    // Trix may adjust what it rendered (its attachment gallery filter); that
    // is a local change.
    if (this.composition.document !== this.lastDoc) this.flushLocal()
  }

  /**
   * The blocks at the top of what is visible of the editor, with where they
   * are on the screen. Trix makes all its nodes anew when it renders, so the
   * browser does not keep the reader's place by itself: lines someone adds
   * above push what the user is reading, or typing, down the screen. Null
   * when the start of the document is in view.
   */
  scrollAnchors () {
    try {
      const el = this.element
      const first = el.firstElementChild
      if (!first) return null
      const doc = el.ownerDocument
      const box = el.getBoundingClientRect()
      const top = Math.max(0, box.top)
      const bottom = Math.min(doc.defaultView.innerHeight, box.bottom)
      if (bottom <= top || first.getBoundingClientRect().bottom > top) return null
      // the block at the top of what is visible: by the element that is there, or between blocks by the last child that starts above
      let node = doc.elementFromPoint(box.left + Math.min(40, box.width / 2), top + 4)
      if (!node || node === el || !el.contains(node)) {
        const kids = el.children
        let lo = 0
        let hi = kids.length - 1
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (kids[mid].getBoundingClientRect().top <= top + 4) lo = mid; else hi = mid - 1
        }
        node = kids[lo]
      }
      const at = this.controller.selectionManager.locationMapper.findLocationFromContainerAndOffset(node, 0)
      if (!at || typeof at.index !== 'number') return null
      const document = this.composition.document
      const anchors = []
      // (a block that does not change is the same object afterwards; the one at the top may be the one that changes)
      for (let index = at.index; index < at.index + 4 && index < document.getBlockCount(); index++) {
        const y = this.blockTop(index)
        if (y !== null) anchors.push([document.getBlockAtIndex(index), y])
      }
      return anchors.length > 0 ? anchors : null
    } catch (e) { return null }
  }

  /** Where the block with this index starts on the screen, or null. */
  blockTop (index) {
    const found = this.controller.selectionManager.findNodeAndOffsetFromLocation({ index, offset: 0 })
    let node = found && found[0]
    if (node && node.nodeType !== 1) node = node.parentElement
    return node ? node.getBoundingClientRect().top : null
  }

  /** Scroll so that the first of the anchors that is still there is where it was. */
  keepScroll (anchors) {
    try {
      const el = this.element
      const blocks = this.composition.document.getBlocks()
      let moved = null
      let byText = null // for blocks that were made anew: where a block with that text is, if there is one such
      for (const [block, y] of anchors) {
        let index = blocks.indexOf(block)
        if (index < 0) {
          if (byText === null) {
            byText = new Map()
            blocks.forEach((b, k) => { const key = b.toString(); byText.set(key, byText.has(key) ? -1 : k) })
          }
          const at = byText.get(block.toString())
          index = at === undefined ? -1 : at
        }
        const now = index < 0 ? null : this.blockTop(index)
        if (now !== null) { moved = now - y; break }
      }
      if (moved === null || Math.abs(moved) < 1) return
      const win = el.ownerDocument.defaultView
      // what scrolls: the editor, a box around it, or the page
      for (let box = el; box && box.nodeType === 1; box = box.parentElement) {
        if (box === el.ownerDocument.body || box === el.ownerDocument.documentElement) break
        const overflow = win.getComputedStyle(box).overflowY
        if ((overflow === 'auto' || overflow === 'scroll') && box.scrollHeight > box.clientHeight) { box.scrollTop += moved; return }
      }
      win.scrollBy(0, moved)
    } catch (e) {}
  }

  /**
   * The text formats the user has switched on or off at the caret for what
   * they type next: how Trix's current attributes differ from those of the
   * text at the caret (null for one switched off). Null if there are none.
   */
  pendingAttributes () {
    try {
      const range = this.composition.getSelectedRange()
      if (!range || range[0] !== range[1]) return null
      const now = this.composition.currentAttributes || {}
      const there = this.composition.document.getCommonAttributesAtRange(range) || {}
      const known = this.config.textAttributes
      const pending = {}
      for (const key of Object.keys(known)) {
        if (key === FROZEN || equal(now[key], there[key])) continue
        pending[key] = now[key] === undefined ? null : now[key]
      }
      return isEmptyObject(pending) ? null : pending
    } catch (e) { return null }
  }

  /**
   * Concurrent edits (or another client) can leave text after the final block
   * break. Trix closes its last block with a break of its own, so its
   * document is then one longer than the Y.Text. That break is not written
   * here: every editor would add one. It is noted, and written by
   * flushLocal() when this editor next makes a change.
   */
  noteTrailingBreak () {
    const n = this.ytext.length
    if (n === 0) { this.missingBreak = false; return }
    const last = sliceRuns(deltaRuns(this.ytext.toDelta()), n - 1, n)[0]
    this.missingBreak = !(last && !last.embed && (last.str === '\n' || last.str === '\r') && last.attrs.blockBreak)
  }

  // ---- selection <-> relative positions -------------------------------------

  selectionToRelative () {
    const range = this.safeSelectedRange()
    if (!range) return null
    const clamp = (i) => Math.max(0, Math.min(i, this.ytext.length))
    // Both ends stay before what someone else types exactly there, which is
    // also where the editor keeps its own caret through a remote change
    // (see mapIndex). With one end of each kind, text typed at somebody's
    // caret came out between the two, and was drawn as that person's
    // selection over the new text.
    return {
      anchor: Y.createRelativePositionFromTypeIndex(this.ytext, clamp(range[0]), -1),
      head: Y.createRelativePositionFromTypeIndex(this.ytext, clamp(range[1]), -1)
    }
  }

  relativeToIndex (rel) {
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.doc)
    if (!abs || abs.type !== this.ytext) return null
    return Math.min(abs.index, Math.max(0, this.composition.document.getLength() - 1))
  }

  restoreSelection ({ anchor, head }) {
    const a = this.relativeToIndex(anchor)
    const h = this.relativeToIndex(head)
    if (a === null || h === null) return
    try { this.editor.setSelectedRange([Math.min(a, h), Math.max(a, h)]) } catch (e) {}
  }

  // ---- undo -----------------------------------------------------------------

  patchUndo () {
    const ed = this.editor
    this.origUndo = { undo: ed.undo, redo: ed.redo, canUndo: ed.canUndo, canRedo: ed.canRedo, recordUndoEntry: ed.recordUndoEntry }
    ed.undo = () => this.runUndo(() => this.undoManager.undo())
    ed.redo = () => this.runUndo(() => this.undoManager.redo())
    ed.canUndo = () => this.undoManager.undoStack.length > 0
    ed.canRedo = () => this.undoManager.redoStack.length > 0
    // Undo steps end where Trix's own would: Yjs alone goes by time, and
    // everything done less than captureTimeout after the change before it
    // is one step. Trix says before each change what kind it is, and makes
    // a new step unless it is more of the same (typing in the same block).
    this.lastUndoKey = null
    ed.recordUndoEntry = (description, { context, consolidatable } = {}) => {
      let key = null
      if (consolidatable) { try { key = JSON.stringify([description, context]) } catch (e) {} }
      // (a composition is one step: see onCompositionStart)
      if (!this.composeStep && (key === null || key !== this.lastUndoKey)) this.undoManager.stopCapturing()
      this.lastUndoKey = key
    }
  }

  runUndo (fn) {
    this.lastUndoKey = null
    this.release()
    if (this.composition.document !== this.lastDoc) this.flushLocal()
    try {
      fn()
    } catch (e) {
      // Known Yjs bug (yjs/yjs#809). Whatever the transaction did is in Y;
      // show exactly that.
      console.error('y-trix: undo failed', e)
      this.renderAll()
    }
    this.updateActions()
  }

  updateActions () {
    if (this.controller && this.controller.updateCurrentActions) this.controller.updateCurrentActions()
  }

  // ---- awareness ------------------------------------------------------------

  setupAwareness () {
    const doc = this.element.ownerDocument
    // opts.cursors === false: this editor's selection is still published,
    // and the other users' are not drawn (the app draws them, or nobody).
    this.overlay = null
    if (this.opts.cursors !== false) {
      this.overlay = doc.createElement('div')
      this.overlay.className = 'y-trix-cursors'
      this.overlay.setAttribute('data-y-trix-overlay', '')
      this.overlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:10'
      doc.body.appendChild(this.overlay)
    }

    this.onSelectionChange = () => {
      if (this.applyingRemote) return
      if (this.held) return // positions are the shadow's until the composition ends
      const cur = this.awareness.getLocalState()
      if (!cur) return
      const sel = this.isFocused() ? this.selectionToRelative() : null
      const json = sel ? { anchor: Y.relativePositionToJSON(sel.anchor), head: Y.relativePositionToJSON(sel.head) } : (cur.cursor || null)
      if (stable(cur.cursor) !== stable(json)) this.awareness.setLocalStateField('cursor', json)
    }
    this.element.addEventListener('trix-selection-change', this.onSelectionChange)
    this.element.addEventListener('trix-change', this.onSelectionChange)
    this.onRender = () => this.renderCursors()
    this.awareness.on('change', this.onRender)
    this.element.addEventListener('trix-render', this.onRender)
    doc.defaultView.addEventListener('resize', this.onRender)
    doc.addEventListener('scroll', this.onRender, true)
  }

  /**
   * Draw the other users' carets, at the next animation frame. Finding
   * where a caret goes makes the browser lay the document out, which it
   * would otherwise do once per frame: drawn after every remote change, a
   * few keystrokes arriving together in a very long block cost a layout
   * each.
   */
  renderCursors () {
    if (!this.overlay || this.destroyed || this.cursorFrame) return
    const win = this.overlay.ownerDocument.defaultView
    const draw = () => {
      this.cursorFrame = 0
      if (!this.overlay || this.destroyed) return
      try {
        this.drawCursors()
      } catch (e) {
        // a peer's awareness state must not be able to break this editor
        console.error('y-trix: drawing remote carets failed', e)
      }
    }
    if (!win || typeof win.requestAnimationFrame !== 'function') { draw(); return }
    this.cursorFrame = win.requestAnimationFrame(draw)
  }

  drawCursors () {
    const doc = this.overlay.ownerDocument
    const win = doc.defaultView
    if (!win) return
    const sm = this.controller && this.controller.selectionManager
    this.overlay.textContent = ''
    const document = this.composition.document
    const max = document.getLength() - 1
    const domRange = (s, e) => {
      try {
        return sm.createDOMRangeFromLocationRange(document.locationRangeFromRange([s, e]))
      } catch (err) { return null }
    }
    this.awareness.getStates().forEach((state, clientID) => {
      if (clientID === this.awareness.clientID || !state || typeof state !== 'object' || !state.cursor || typeof state.cursor !== 'object') return
      const user = state.user
      const color = cursorColor(user)
      let a, h
      try {
        a = this.relativeToIndex(Y.createRelativePositionFromJSON(state.cursor.anchor))
        h = this.relativeToIndex(Y.createRelativePositionFromJSON(state.cursor.head))
      } catch (e) { return }
      if (a === null || h === null) return
      a = Math.min(a, max); h = Math.min(h, max)
      const sx = win.scrollX
      const sy = win.scrollY
      if (a !== h) {
        const r = domRange(Math.min(a, h), Math.max(a, h))
        if (r) {
          for (const rect of Array.from(r.getClientRects())) {
            if (rect.width === 0) continue
            const box = doc.createElement('div')
            box.className = 'y-trix-selection'
            box.style.cssText = `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;width:${rect.width}px;height:${rect.height}px;background:${color};opacity:.25`
            box.style.setProperty('--y-trix-color', color)
            this.overlay.appendChild(box)
          }
        }
      }
      const caretRange = domRange(h, h)
      let rect = caretRange && caretRange.getClientRects()[0]
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        // Empty block or block start: measure the next character instead.
        const r = domRange(h, Math.min(h + 1, max + 1))
        const rects = r ? Array.from(r.getClientRects()) : []
        rect = rects[0] ? { left: rects[0].left, top: rects[0].top, height: rects[0].height } : null
      }
      if (!rect) return
      const caret = doc.createElement('div')
      caret.setAttribute('data-y-caret', String(clientID))
      caret.className = 'y-trix-caret'
      caret.style.cssText = `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;width:2px;height:${rect.height || 16}px;background:${color}`
      caret.style.setProperty('--y-trix-color', color)
      const label = doc.createElement('div')
      label.textContent = cursorName(user, clientID)
      label.className = 'y-trix-caret-label'
      label.style.cssText = `position:absolute;left:0;top:-14px;font:10px sans-serif;color:#fff;background:${color};padding:0 3px;white-space:nowrap;border-radius:2px;max-width:160px;overflow:hidden;text-overflow:ellipsis`
      caret.appendChild(label)
      this.overlay.appendChild(caret)
    })
  }

  // ---- teardown -------------------------------------------------------------

  destroy () {
    if (this.destroyed) return
    if (!this.attached) {
      // never got as far as the editor
      this.destroyed = true
      this.element.removeEventListener('trix-initialize', this.onInitialize)
      return
    }
    this.release()
    this.destroyed = true
    if (this.onInitialize) this.element.removeEventListener('trix-initialize', this.onInitialize)
    this.element.removeEventListener('trix-file-accept', this.onFileAccept)
    if (this.verifyTimer) clearTimeout(this.verifyTimer)
    for (const type of ['input', 'keyup', 'mouseup', 'focusin']) this.element.ownerDocument.removeEventListener(type, this.onFieldEvent, true)
    this.element.removeEventListener('mousedown', this.onMouseDown)
    this.win.removeEventListener('mousemove', this.onMouseMove, true)
    for (const type of ['mouseup', 'dragend', 'drop', 'blur']) this.win.removeEventListener(type, this.onMouseUp, true)
    this.element.removeEventListener('compositionstart', this.onCompositionStart)
    this.element.removeEventListener('compositionend', this.onCompositionEnd)
    this.element.removeEventListener('blur', this.onBlur)
    if (this.shadow) { this.doc.off('update', this.onDocUpdate); this.shadow.destroy() }
    this.ytext.unobserve(this.onYChange)
    this.composition.setDocument = this.origSetDocument
    this.editor.filters.splice(0, this.editor.filters.length, ...this.origFilters)
    this.element.removeEventListener('trix-attachment-edit', this.onAttachmentEdit)
    this.element.removeEventListener('input', this.onInput)
    Object.assign(this.editor, this.origUndo)
    this.undoManager.off('stack-item-added', this.onStackAdded)
    this.undoManager.off('stack-item-popped', this.onStackPopped)
    if (this.ownsUndo) {
      this.undoManager.destroy()
    } else {
      this.undoManager.captureTimeout = this.capturePause
      this.undoManager.removeTrackedOrigin(this)
    }
    if (this.awareness) {
      const doc = this.element.ownerDocument
      this.element.removeEventListener('trix-selection-change', this.onSelectionChange)
      this.element.removeEventListener('trix-change', this.onSelectionChange)
      this.element.removeEventListener('trix-render', this.onRender)
      this.awareness.off('change', this.onRender)
      doc.defaultView.removeEventListener('resize', this.onRender)
      doc.removeEventListener('scroll', this.onRender, true)
      if (this.awareness.getLocalState() !== null) this.awareness.setLocalStateField('cursor', null)
      if (this.overlay) this.overlay.remove()
    }
  }
}

/** Carry an index through a Y.Text delta. Inserts at the index go after it. */
const mapIndex = (delta, index) => {
  let pos = 0 // position in the new text
  let rest = index // characters of the old text before index not yet passed
  for (const op of delta) {
    if (op.insert !== undefined) {
      const n = typeof op.insert === 'string' ? op.insert.length : 1
      if (rest === 0) return pos
      pos += n
    } else if (op.delete !== undefined) {
      if (rest <= op.delete) return pos
      rest -= op.delete
    } else {
      if (rest <= op.retain) return pos + rest
      pos += op.retain
      rest -= op.retain
    }
  }
  return pos + rest
}

const rangesEqual = (a, b) =>
  a.startContainer === b.startContainer && a.startOffset === b.startOffset &&
  a.endContainer === b.endContainer && a.endOffset === b.endOffset
