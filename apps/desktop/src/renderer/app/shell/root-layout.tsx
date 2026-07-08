import { Outlet } from "@tanstack/react-router"
import { CommandPalette } from "@expand/desktop/renderer/features/command/components/CommandPalette"

export const RootLayout = () => (
  <>
    <Outlet />
    <CommandPalette />
  </>
)
