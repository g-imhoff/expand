import { create } from "zustand"

// The ONLY shared ephemeral state for the palette: its visibility. Toggled by
// the global keybind (use-command-palette-hotkey) and by the dialog's
// onOpenChange. No server data lives here — projects flow in as props.
export interface CommandPaletteState {
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly toggle: () => void
}

// zustand v5 + TS requires the CURRIED form `create<T>()(...)` — the empty `()`
// after the generic is a workaround for the invariant state generic
// (microsoft/TypeScript#10571). The non-curried `create<T>(...)` mis-infers.
export const useCommandPalette = create<CommandPaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open }))
}))
