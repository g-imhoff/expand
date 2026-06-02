// Pure, DOM-free matcher so it can be unit-tested under the root tsconfig
// (lib: ES2022, no DOM). The React hook that listens on `window` lives in
// use-command-palette-hotkey.ts and is never imported by a test.
//
// `code` is the PHYSICAL key (layout-independent).
export interface HotkeyEvent {
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly code: string
}

// Ctrl+Shift+P (Windows/Linux) or Cmd+Shift+P (macOS).
export const isCommandPaletteHotkey = (event: HotkeyEvent): boolean =>
  (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyP"
