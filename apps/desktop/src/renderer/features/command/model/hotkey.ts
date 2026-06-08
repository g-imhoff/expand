export interface HotkeyEvent {
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly code: string
}

export const isCommandPaletteHotkey = (event: HotkeyEvent): boolean =>
  (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP"
