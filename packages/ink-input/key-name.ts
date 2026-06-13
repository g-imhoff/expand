// packages/ink-input/key-name.ts
// Pure module — must never import "ink". The InkKey shape mirrors ink's Key
// structurally (the MainPortLike idiom) so the adapter can pass ink's object
// straight through while this module stays renderer-agnostic and unit-testable.

export type InkKey = {
  readonly upArrow: boolean
  readonly downArrow: boolean
  readonly leftArrow: boolean
  readonly rightArrow: boolean
  readonly return: boolean
  readonly escape: boolean
  readonly tab: boolean
  readonly backspace: boolean
  readonly delete: boolean
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly pageUp: boolean
  readonly pageDown: boolean
}

/**
 * Canonical key name: "a", "A", "data" (paste), "up", "down", "left", "right",
 * "return", "escape", "tab", "backspace", "delete", "pageup", "pagedown",
 * "ctrl+x", "meta+k". ALL terminal quirks are normalized here and only here.
 */
export type KeyName = string

export const toKeyName = (input: string, key: InkKey): KeyName => {
  if (key.upArrow) return "up"
  if (key.downArrow) return "down"
  if (key.leftArrow) return "left"
  if (key.rightArrow) return "right"
  if (key.pageUp) return "pageup"
  if (key.pageDown) return "pagedown"
  if (key.return) return "return"
  if (key.escape) return "escape"
  if (key.tab) return "tab"
  if (key.backspace) return "backspace"
  if (key.delete) return "delete"
  if (key.ctrl) return input.length > 0 ? `ctrl+${input.toLowerCase()}` : "ctrl"
  if (key.meta) return input.length > 0 ? `meta+${input.toLowerCase()}` : "meta"
  return input
}
