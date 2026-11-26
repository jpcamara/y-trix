// y-trix: a Yjs binding for Trix (prototype).
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

const OBJECT = '￼' // Trix's (and our) string stand-in for an attachment

const SURROGATE = /[\ud800-\udfff]/
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const stable = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}
const equal = (a, b) => a === b || stable(a) === stable(b)

const isEmptyObject = (o) => !o || Object.keys(o).length === 0

/**
 * Y attributes of a block's break character. Trix can leave text attributes
 * on the break piece (bold applied across a block boundary), so they are kept.
 */
const breakAttrs = (block, piece) => {
  const attrs = { ...piece.getAttributes(), blockBreak: true }
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
        runs.push({ embed: { attachment: piece.attachment.getAttributes() }, attrs: piece.getAttributes(), attachment: piece.attachment })
      } else if (piece.isBlockBreak()) {
        runs.push({ str: '\n', attrs: breakAttrs(block, piece) })
      } else {
        runs.push({ str: piece.toString(), attrs: piece.getAttributes() })
      }
    }
  }
  return runs
}

const runsString = (runs) => runs.map((r) => (r.embed ? OBJECT : r.str)).join('')

/** Per-character view of runs: [run, offsetInRun] for each character. */
const charIndex = (runs) => {
  const out = []
  for (const r of runs) {
    const n = r.embed ? 1 : r.str.length
    for (let i = 0; i < n; i++) out.push(r)
  }
  return out
}

/** Y.Text delta ops as runs. */
/** A string that is equal for two Trix documents that hold the same thing. */
const docSig = (document) => stable(document.getBlocks().map((b) => [
  b.attributes, b.htmlAttributes || {},
  b.text.getPieces().map((p) => [p.attachment ? { att: p.attachment.getAttributes() } : p.toString(), p.getAttributes()])
]))

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
   * @param {HTMLElement} element a <trix-editor> that has fired trix-initialize
   * @param {import('y-protocols/awareness').Awareness} [awareness]
   * @param {{ captureTimeout?: number, Trix?: any }} [opts]
   */
  constructor (ytext, element, awareness, opts = {}) {
    this.ytext = ytext
    this.doc = /** @type {Y.Doc} */ (ytext.doc)
    this.element = element
    this.editor = element.editor
    this.controller = element.editorController
    this.composition = this.editor.composition
    this.awareness = awareness || null
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
      const result = origSetDocument.call(composition, document)
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
    this.onAttachmentEdit = (e) => this.syncAttachment(e.attachment.attachment || e.attachment)
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
    this.destroyed = false
    this.held = false
    this.splitPending = false
    this.composing = false
    this.shadow = null
    this.shadowText = null
    this.onCompositionStart = () => { this.composing = true; this.hold() }
    this.onCompositionEnd = () => {
      this.composing = false
      // after Trix (and Safari's late insertFromComposition) have finished
      setTimeout(() => { if (!this.composing) this.release() }, 0)
    }
    this.onBlur = () => { if (!this.composing) this.release() }
    element.addEventListener('compositionstart', this.onCompositionStart)
    element.addEventListener('compositionend', this.onCompositionEnd)
    element.addEventListener('blur', this.onBlur)

    this.undoManager = new Y.UndoManager(ytext, {
      trackedOrigins: new Set([this]),
      captureTimeout: opts.captureTimeout ?? 500
    })
    this.undoManager.on('stack-item-added', (e) => {
      e.stackItem.meta.set('selection', this.selectionToRelative())
      this.updateActions()
    })
    this.undoManager.on('stack-item-popped', (e) => {
      const sel = e.stackItem.meta.get('selection')
      if (sel && this.isFocused()) this.restoreSelection(sel)
      this.updateActions()
    })
    this.patchUndo()

    this.onYChange = (event, tr) => {
      if (this.destroyed) return
      this.scheduleVerify()
      if (tr.origin === this) return
      if (this.held) return // shown when the composition ends
      try {
        this.applyRemote(event)
      } catch (e) {
        // Whatever a peer sent, keep going: show what Y holds.
        console.error('y-trix: applying a remote change failed', e)
        try { this.renderAll() } catch (e2) { console.error('y-trix: redraw failed', e2) }
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
  }

  isFocused () {
    return this.element.ownerDocument.activeElement === this.element
  }

  safeSelectedRange () {
    try { return this.composition.getSelectedRange() || null } catch (e) { return null }
  }

  // ---- local Trix -> Yjs ----------------------------------------------------

  /**
   * Write the difference between the last synced document and the current
   * one into Yjs.
   * @param {number} [hint] caret position in the new document, used to place
   *   an ambiguous edit where the user made it
   */
  flushLocal (hint) {
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
    this.wdoc.transact(() => this.applyRuns(base, aRuns, bRuns, hint === undefined ? undefined : hint - base), this)
    if (split) {
      // (not while an input method is composing: a render would end the
      // composition, so the editor shows it when the composition is over)
      if (this.held) this.splitPending = true
      else this.showSplit()
    }
  }

  /** Show the U+FFFD that was written for half an emoji. */
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
    const aStr = runsString(aRuns)
    const bStr = runsString(bRuns)
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
      if (remove > 0) ytext.delete(base + index, remove)
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
    const attrs = attachment.getAttributes()
    if (!op || !op.embed || equal(op.embed.attachment, attrs)) return
    const piece = document.getAttachmentPieceForAttachment(attachment)
    this.doc.transact(() => {
      const embed = { attachment: { ...attrs } }
      this.attachments.set(embed, attachment)
      this.ytext.delete(pos, 1)
      this.ytext.insertEmbed(pos, embed, piece ? piece.getAttributes() : op.attrs)
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
    const observe = (e) => { event = e }
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
        const attachment = cleanAttachment(r.embed)
        if (attachment === null) { addText(BAD_EMBED, {}); continue }
        flushText()
        let att = this.attachments.get(r.embed)
        // Attachments change in place, so a remembered one can be newer than
        // its embed (undo brings the old embed back). Then make one from the
        // embed.
        if (!att || !equal(att.getAttributes(), attachment)) {
          att = new Attachment(attachment)
          this.attachments.set(r.embed, att)
        }
        pieces.push(new AttachmentPiece(att, this.cleanTextAttrs(r.attrs, true)))
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
   * Text attributes from Y that Trix is configured for, with values of the
   * kind Trix stores: true, or a string or number (href). Block attributes
   * are dropped; they belong on block breaks only.
   */
  cleanTextAttrs (attrs, attachment = false) {
    const known = this.config.textAttributes
    const out = {}
    for (const key of Object.keys(attrs)) {
      if (key === 'blockBreak' || key === 'block' || key === 'html') continue
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
   * Trix turns "\r\n" into "\n" in every string it stores, which would leave
   * its document shorter than the Y.Text. Trix never writes a "\r" itself,
   * so one can only come from another client: delete the "\r" of each pair
   * in Y. Only deleting keeps this safe when every editor does it at once.
   * (A "\r" on its own becomes "\n" in Trix, the same length, and stays.)
   * @return {boolean} whether Y changed
   */
  normalizeNewlines () {
    const fixes = []
    let pos = 0
    const delta = this.ytext.toDelta()
    delta.forEach((op, i) => {
      if (typeof op.insert !== 'string') { pos += 1; return }
      for (let k = 0; k < op.insert.length; k++) {
        if (op.insert[k] !== '\r') continue
        const next = k + 1 < op.insert.length ? op.insert[k + 1] : (delta[i + 1] && typeof delta[i + 1].insert === 'string' ? delta[i + 1].insert[0] : '')
        if (next === '\n') fixes.push(pos + k)
      }
      pos += op.insert.length
    })
    if (fixes.length === 0) return false
    this.doc.transact(() => {
      for (let i = fixes.length - 1; i >= 0; i--) this.ytext.delete(fixes[i], 1)
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
    this.normalizeNewlines()
    const blocks = this.runsToBlocks(deltaRuns(this.ytext.toDelta()))
    this.setDocumentRemote(new this.T.Document(blocks))
    this.noteTrailingBreak()
  }

  applyRemote (event) {
    if (this.composition.document !== this.lastDoc) {
      console.warn('y-trix: unsynced local change while applying a remote update')
    }
    // Changed range, in old and new coordinates.
    let oldPos = 0
    let newPos = 0
    let start = -1
    let oldEnd = 0
    let newEnd = 0
    if (this.normalizeNewlines()) {
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
    if (start < 0) return
    const newLen = this.ytext.length
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
    const active = this.element.ownerDocument.activeElement
    // Trix does not redraw while an attachment is selected for editing, so
    // nothing anyone else did would show until this user clicked away.
    // Deselect it, unless they are typing its caption.
    if (this.composition.editingAttachment) {
      const field = this.element.ownerDocument.activeElement
      const inCaption = field !== null && field.nodeName === 'TEXTAREA' && this.element.contains(field)
      if (!inCaption) this.composition.stopEditingAttachment()
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
    // Trix skips rendering while it handles an input event and renders after
    // only if its own input code asked. Undo from the keyboard lands here
    // inside such an event, so render now, as Trix's own undo does.
    if (this.controller.handlingInput) this.controller.render()
    if (focused && sel) {
      try { this.editor.setSelectedRange(sel) } catch (e) {}
    } else if (!focused) {
      if (saved && (domSel.rangeCount === 0 || !rangesEqual(domSel.getRangeAt(0), saved))) {
        domSel.removeAllRanges()
        domSel.addRange(saved)
      }
      if (active && this.element.ownerDocument.activeElement !== active && active.focus) active.focus({ preventScroll: true })
    }
    // Trix may adjust what it rendered (its attachment gallery filter); that
    // is a local change.
    if (this.composition.document !== this.lastDoc) this.flushLocal()
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
    return {
      anchor: Y.createRelativePositionFromTypeIndex(this.ytext, clamp(range[0])),
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
    ed.recordUndoEntry = () => {}
  }

  runUndo (fn) {
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
    this.overlay = doc.createElement('div')
    this.overlay.setAttribute('data-y-trix-overlay', '')
    this.overlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:10'
    doc.body.appendChild(this.overlay)

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

  renderCursors () {
    if (!this.overlay || this.destroyed) return
    try {
      this.drawCursors()
    } catch (e) {
      // a peer's awareness state must not be able to break this editor
      console.error('y-trix: drawing remote carets failed', e)
    }
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
            box.style.cssText = `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;width:${rect.width}px;height:${rect.height}px;background:${color};opacity:.25`
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
      caret.style.cssText = `position:absolute;left:${rect.left + sx}px;top:${rect.top + sy}px;width:2px;height:${rect.height || 16}px;background:${color}`
      const label = doc.createElement('div')
      label.textContent = cursorName(user, clientID)
      label.style.cssText = `position:absolute;left:0;top:-14px;font:10px sans-serif;color:#fff;background:${color};padding:0 3px;white-space:nowrap;border-radius:2px;max-width:160px;overflow:hidden;text-overflow:ellipsis`
      caret.appendChild(label)
      this.overlay.appendChild(caret)
    })
  }

  // ---- teardown -------------------------------------------------------------

  destroy () {
    if (this.destroyed) return
    this.release()
    this.destroyed = true
    if (this.verifyTimer) clearTimeout(this.verifyTimer)
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
    this.undoManager.destroy()
    if (this.awareness) {
      const doc = this.element.ownerDocument
      this.element.removeEventListener('trix-selection-change', this.onSelectionChange)
      this.element.removeEventListener('trix-change', this.onSelectionChange)
      this.element.removeEventListener('trix-render', this.onRender)
      this.awareness.off('change', this.onRender)
      doc.defaultView.removeEventListener('resize', this.onRender)
      doc.removeEventListener('scroll', this.onRender, true)
      if (this.awareness.getLocalState() !== null) this.awareness.setLocalStateField('cursor', null)
      this.overlay.remove()
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
