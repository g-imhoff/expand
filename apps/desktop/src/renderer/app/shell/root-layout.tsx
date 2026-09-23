import { useState } from "react"
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { Menu } from "lucide-react"
import { CommandPalette } from "@expand/desktop/renderer/features/command/components/CommandPalette"
import { SidebarInset, SidebarProvider, useSidebar } from "@expand/desktop/renderer/components/ui/sidebar"
import { AppSidebar } from "@expand/desktop/renderer/features/sidebar/components/AppSidebar"
import { defaultSidebarDevices, defaultSidebarWorktrees } from "@expand/desktop/renderer/features/sidebar/data/sidebar-data"

export const RootLayout = () => {
  return (
    <SidebarProvider defaultOpen>
      <RootLayoutContent />
    </SidebarProvider>
  )
}

const RootLayoutContent = () => {
  const navigate = useNavigate()
  const { openMobile, setOpenMobile } = useSidebar()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const activeProjectId = pathname.startsWith("/p/") ? decodeURIComponent(pathname.slice(3).split("/")[0] ?? "") : null
  const [activeDeviceId, setActiveDeviceId] = useState<string | undefined>(defaultSidebarDevices[0]?.id)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)

  return (
    <>
      <AppSidebar
        activeProjectId={activeProjectId}
        onSelectProject={(projectId) => {
          setOpenMobile(false)
          void navigate({ to: "/p/$projectId", params: { projectId } })
        }}
        activeDeviceId={activeDeviceId}
        onSelectDevice={setActiveDeviceId}
        groups={defaultSidebarWorktrees}
        activeConversationId={activeConversationId}
        onSelectConversation={setActiveConversationId}
      />
      <SidebarInset>
        <div className="flex items-center border-b px-3 py-2 md:hidden">
          <button
            type="button"
            aria-label="Open sidebar"
            aria-expanded={openMobile}
            onClick={() => setOpenMobile(true)}
            className="flex size-10 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
        </div>
        <Outlet />
      </SidebarInset>
      <CommandPalette />
    </>
  )
}
