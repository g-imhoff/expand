import { Outlet } from "@tanstack/react-router"
import { CommandPalette } from "@yodea/desktop/renderer/features/command/components/CommandPalette"

export const RootLayout = () => (
  <>
    <Outlet />
    <CommandPalette />
  </>
)
