import { useState } from "react"
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { CommandPalette } from "@expand/desktop/renderer/features/command/components/CommandPalette"
import { SidebarInset, SidebarProvider } from "@expand/desktop/renderer/components/ui/sidebar"
import { AppSidebar } from "@expand/desktop/renderer/features/sidebar/components/AppSidebar"
import { defaultSidebarDevices, defaultSidebarWorktrees } from "@expand/desktop/renderer/features/sidebar/data/sidebar-data"

export const RootLayout = () => {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const activeProjectId = pathname.startsWith("/p/") ? decodeURIComponent(pathname.slice(3).split("/")[0] ?? "") : null
  const [activeDeviceId, setActiveDeviceId] = useState<string | undefined>(defaultSidebarDevices[0]?.id)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar
        activeProjectId={activeProjectId}
        onSelectProject={(projectId) => {
          void navigate({ to: "/p/$projectId", params: { projectId } })
        }}
        activeDeviceId={activeDeviceId}
        onSelectDevice={setActiveDeviceId}
        groups={defaultSidebarWorktrees}
        activeConversationId={activeConversationId}
        onSelectConversation={setActiveConversationId}
      />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
  )
}
