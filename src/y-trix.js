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
    /** Y embed object -> Trix Attachment, so rebuilt blocks keep their attachments. */
    this.attachments = new WeakMap()
    this.applyingRemote = false

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
      if (tr.origin === this) return
      this.applyRemote(event)
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
    const b = next.getBlocks()
    if (this.ytext.length === 0) {
      // Y holds nothing yet (an empty Trix document has one empty block).
      if (next.isEmpty()) return
      this.doc.transact(() => this.applyRuns(0, [], trixRuns(b), hint), this)
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
    this.doc.transact(() => this.applyRuns(base, aRuns, bRuns, hint === undefined ? undefined : hint - base), this)
  }

  /**
   * Change the Y text at [base, base + |aRuns|), which holds aRuns, into bRuns.
   */
  applyRuns (base, aRuns, bRuns, cursor) {
    const ytext = this.ytext
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
        this.ytext.insertEmbed(at, embed, { ...run.attrs })
        at++; i++
        continue
      }
      let j = i
      while (j < to && bChars[j] === run) j++
      // offset of i inside its run
      let start = i
      while (start > 0 && bChars[start - 1] === run) start--
      const str = run.str.slice(i - start, j - start)
      this.ytext.insert(at, str, { ...run.attrs })
      at += str.length
      i = j
    }
  }

  syncAttachment (attachment) {
    if (!attachment) return
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

  // ---- remote Yjs -> Trix ---------------------------------------------------

  /** Build Trix blocks from runs. Text without a closing block break becomes a block. */
  runsToBlocks (runs) {
    const { Block, Text, StringPiece, AttachmentPiece, Attachment } = this.T
    const blocks = []
    let pieces = []
    const close = (attrs) => {
      pieces.push(new StringPiece('\n', { ...textAttrs(attrs), blockBreak: true }))
      blocks.push(new Block(new Text(pieces), attrs.block ? attrs.block.slice() : [], attrs.html ? { ...attrs.html } : {}))
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
        flushText()
        let att = this.attachments.get(r.embed)
        // Attachments change in place, so a remembered one can be newer than
        // its embed (undo brings the old embed back). Then make one from the
        // embed.
        if (!att || !equal(att.getAttributes(), r.embed.attachment || {})) {
          att = new Attachment(r.embed.attachment || {})
          this.attachments.set(r.embed, att)
        }
        pieces.push(new AttachmentPiece(att, textAttrs(r.attrs)))
        continue
      }
      // Block attributes belong on block breaks only. Concurrent edits (and
      // undo restoring format markers) can leave them on other characters;
      // those are ignored there.
      const plain = textAttrs(r.attrs)
      if (!r.attrs.blockBreak) { addText(r.str, plain); continue }
      for (const ch of r.str) {
        if (ch === '\n') { flushText(); close(r.attrs) } else addText(ch, plain)
      }
    }
    flushText()
    if (pieces.length > 0) blocks.push(new Block(new Text(pieces)))
    return blocks
  }

  renderAll () {
    const blocks = this.runsToBlocks(deltaRuns(this.ytext.toDelta()))
    this.setDocumentRemote(new this.T.Document(blocks))
    this.repairTrailingBreak()
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
    if (oldLen !== old.getLength() || blocks.length === 0) {
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
    this.repairTrailingBreak()
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
    this.applyingRemote = true
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
   * Concurrent edits can leave text after the final block break. Close it with
   * a break so Y and Trix keep the same length.
   */
  repairTrailingBreak () {
    const n = this.ytext.length
    if (n === 0) return
    const last = sliceRuns(deltaRuns(this.ytext.toDelta()), n - 1, n)[0]
    if (last && !last.embed && last.str === '\n' && last.attrs.blockBreak) return
    this.doc.transact(() => this.ytext.insert(n, '\n', { blockBreak: true }), this)
    this.lastDoc = this.composition.document
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
    if (!this.overlay) return
    const doc = this.overlay.ownerDocument
    const win = doc.defaultView
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
      if (clientID === this.awareness.clientID || !state.cursor) return
      const user = state.user || {}
      const color = user.color || '#ffa500'
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
      label.textContent = user.name || String(clientID)
      label.style.cssText = `position:absolute;left:0;top:-14px;font:10px sans-serif;color:#fff;background:${color};padding:0 3px;white-space:nowrap;border-radius:2px`
      caret.appendChild(label)
      this.overlay.appendChild(caret)
    })
  }

  // ---- teardown -------------------------------------------------------------

  destroy () {
    this.ytext.unobserve(this.onYChange)
    this.composition.setDocument = this.origSetDocument
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
      this.awareness.setLocalStateField('cursor', null)
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
