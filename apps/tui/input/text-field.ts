import type { KeyEvent } from "@expand/ink-input"

export type TextFieldState = { readonly value: string; readonly cursor: number }
export const emptyTextField: TextFieldState = { value: "", cursor: 0 }
export const textField = (value: string): TextFieldState => ({ value, cursor: [...value].length })
export const editTextField = (state: TextFieldState, event: KeyEvent): TextFieldState | null => {
  if (event.ctrl || event.meta) return null
  const chars = [...state.value]
  if (event.key === "backspace" || event.key === "delete") return state.cursor > 0 ? { value: chars.slice(0, state.cursor - 1).concat(chars.slice(state.cursor)).join(""), cursor: state.cursor - 1 } : state
  if (event.input.length === 0 || event.key !== event.input) return null
  const inserted = [...event.input]
  return { value: chars.slice(0, state.cursor).concat(inserted, chars.slice(state.cursor)).join(""), cursor: state.cursor + inserted.length }
}
