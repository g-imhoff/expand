import { useEffect } from "react"
import { isCommandPaletteHotkey } from "./hotkey"
import { useCommandPalette } from "./store"

// Registers a window-level keydown listener that toggles the palette on
// Ctrl/Cmd+Shift+P. preventDefault stops any default binding; the listener is
// removed on unmount.
export const useCommandPaletteHotkey = (): void => {
  const toggle = useCommandPalette((state) => state.toggle)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCommandPaletteHotkey(event)) {
        event.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggle])
}
