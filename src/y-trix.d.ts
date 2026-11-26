import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

export interface TrixBindingOptions {
  /** The pause, in ms, that ends an undo step. Default 500. */
  captureTimeout?: number
  /** The Trix object, if it is not the global one. */
  Trix?: unknown
  /** After every step, compare the editor with Y and log the first step that leaves them different. Slow; for tests. */
  debug?: boolean
}

export class TrixBinding {
  /**
   * @param ytext the shared text that holds the document
   * @param element a `<trix-editor>` that has fired `trix-initialize`
   * @param awareness publishes the local selection and draws the other users' carets
   */
  constructor (ytext: Y.Text, element: HTMLElement, awareness?: Awareness | null, options?: TrixBindingOptions)
  readonly ytext: Y.Text
  readonly doc: Y.Doc
  readonly element: HTMLElement
  readonly awareness: Awareness | null
  /** Behind `editor.undo()` and `editor.redo()`: only this binding's changes. */
  readonly undoManager: Y.UndoManager
  /** Takes the binding off the editor and gives Trix its own undo back. The editor keeps its content. */
  destroy (): void
}
