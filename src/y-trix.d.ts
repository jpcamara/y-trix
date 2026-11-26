import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export interface TrixBindingOptions {
  /** The pause, in ms, that ends an undo step. Default 500. Not used with `undoManager`. */
  captureTimeout?: number
  /**
   * Your own undo manager, in place of the one the binding makes: one for
   * several editors, or one that tracks more than this binding. The binding
   * adds itself to its tracked origins. It is yours to destroy.
   */
  undoManager?: Y.UndoManager
  /** `false`: do not draw the other users' carets and selections. This editor's selection is still published. Default true. */
  cursors?: boolean
  /** `false`: refuse files, and show attachments in the shared document as U+FFFD. Default true. */
  attachments?: boolean
  /** The Trix object, if it is not `globalThis.Trix`. */
  Trix?: unknown
  /** After every step, compare the editor with Y and log the first step that leaves them different. Slow; for tests. */
  debug?: boolean
}

export class TrixBinding {
  /**
   * @param ytext the shared text that holds the document
   * @param element a `<trix-editor>`. One that Trix has not set up yet is bound once it fires `trix-initialize`.
   * @param awareness publishes the local selection and draws the other users' carets
   */
  constructor (ytext: Y.Text, element: HTMLElement, awareness?: Awareness | null, options?: TrixBindingOptions)
  readonly ytext: Y.Text
  readonly doc: Y.Doc
  readonly element: HTMLElement
  readonly awareness: Awareness | null
  /** Resolves with the binding once it is on the editor: at once for an editor that is set up, after `trix-initialize` otherwise. */
  readonly ready: Promise<TrixBinding>
  /** Behind `editor.undo()` and `editor.redo()`. Undefined until `ready`. */
  readonly undoManager: Y.UndoManager
  /** Takes the binding off the editor and gives Trix its own undo back. The editor keeps its content. */
  destroy (): void
}
