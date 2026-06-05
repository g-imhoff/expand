import { useEffect } from "react"
import { isCommandPaletteHotkey } from "./hotkey"
import { useCommandPalette } from "./store"

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
