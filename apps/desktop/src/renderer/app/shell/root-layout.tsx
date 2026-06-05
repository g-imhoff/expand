import { Outlet } from "@tanstack/react-router"
import { CommandPalette } from "@yodea/desktop/renderer/command/CommandPalette"

export const RootLayout = () => (
  <>
    <Outlet />
    <CommandPalette />
  </>
)
