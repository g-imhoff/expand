import { create } from "zustand"

export interface CommandPaletteState {
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly toggle: () => void
}

export const useCommandPalette = create<CommandPaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((state) => ({ open: !state.open }))
}))
