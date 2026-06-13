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
 * keys arrive with empty input). The literal-text rule is checked FIRST so a
 * pasted word like "delete" / "return" / "tab" is appended as text rather than
 * triggering a key action or leaking to the router: real special keys never
 * have input equal to their canonical name (their input is empty or a control
 * char like "\r" / "\t", never the name), so this is safe. The pass-through
 * set is implicit: return / escape / tab and chords / navigation keys arrive
 * with input that is empty or not equal to the name, so none are claimed.
 */
export const textFieldConsumes = (keyName: KeyName, input: string): boolean => {
  if (input.length > 0 && keyName === input) return true
  return keyName === "backspace" || keyName === "delete"
}

export const textFieldReduce = (
  state: TextFieldState, keyName: KeyName, input: string
): TextFieldState => {
  if (input.length > 0 && keyName === input) return { value: state.value + input }
  if (keyName === "backspace" || keyName === "delete") {
    // No cursor support yet: forward-delete deliberately degrades to backspace.
    // Code-point-safe slice — plain .slice(0, -1) would split surrogate pairs.
    return { value: [...state.value].slice(0, -1).join("") }
  }
  return state
}
