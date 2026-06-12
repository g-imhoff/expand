// packages/ink-input/text-field.ts
// Pure module — must never import "ink". Generic text-entry semantics shared
// by every text field. Cursor support can be added here later, in one place.
import type { KeyName } from "@yodea/ink-input/key-name"

export type TextFieldState = { readonly value: string }

export const emptyTextField: TextFieldState = { value: "" }
export const textField = (value: string): TextFieldState => ({ value })

/**
 * The Textual check_consume_key rule: which keys a text field claims.
 * Printable text is recognized as keyName === input (covers paste, and makes
 * pasted strings that spell key names — "up" — unambiguous, since real arrow
 * keys arrive with empty input). The pass-through set is explicit and tiny:
 * return / escape / tab fall through to the router; chords and navigation
 * keys are never claimed.
 */
export const textFieldConsumes = (keyName: KeyName, input: string): boolean => {
  if (keyName === "backspace" || keyName === "delete") return true
  if (keyName === "return" || keyName === "escape" || keyName === "tab") return false
  return input.length > 0 && keyName === input
}

export const textFieldReduce = (
  state: TextFieldState, keyName: KeyName, input: string
): TextFieldState => {
  if (keyName === "backspace" || keyName === "delete") {
    return { value: state.value.slice(0, -1) }
  }
  if (textFieldConsumes(keyName, input)) return { value: state.value + input }
  return state
}
