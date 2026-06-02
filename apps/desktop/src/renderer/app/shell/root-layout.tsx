import { Outlet } from "@tanstack/react-router"
import { CommandPalette } from "@yodea/desktop/renderer/command/CommandPalette"

// Root route layout: the routed page (Outlet) plus the always-mounted command
// palette. Rendering the palette at the root means Ctrl/Cmd+Shift+P works on
// every route, and the palette sits inside Router + TanStack Query + RPC context.
export const RootLayout = () => (
  <>
    <Outlet />
    <CommandPalette />
  </>
)
