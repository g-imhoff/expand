import { useEffect, useState } from "react"
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { ArrowLeft, Menu } from "lucide-react"
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
  const activeConversation = defaultSidebarWorktrees
    .flatMap((group) => group.conversations)
    .find((conversation) => conversation.id === activeConversationId)

  useEffect(() => {
    setActiveConversationId(null)
  }, [pathname])

  return (
    <>
      <AppSidebar
        activeProjectId={activeProjectId}
        onSelectProject={(projectId) => {
          setActiveConversationId(null)
          setOpenMobile(false)
          void navigate({ to: "/p/$projectId", params: { projectId } })
        }}
        activeDeviceId={activeDeviceId}
        onSelectDevice={(deviceId) => {
          setActiveConversationId(null)
          setActiveDeviceId(deviceId)
        }}
        groups={defaultSidebarWorktrees}
        activeConversationId={activeConversationId}
        onSelectConversation={(conversationId) => {
          setActiveConversationId(conversationId)
          setOpenMobile(false)
        }}
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
        {activeConversation ? (
          <article className="mx-auto w-full max-w-3xl px-6 py-8">
            <button
              type="button"
              onClick={() => setActiveConversationId(null)}
              className="inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to {activeProjectId === null ? "projects" : "workspace"}
            </button>
            <div className="mt-8 border-b pb-6">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Sample conversation preview
              </p>
              <h1 className="mt-2 text-2xl font-semibold">{activeConversation.title}</h1>
              <p className="mt-4 text-sm text-muted-foreground">{activeConversation.teaser}</p>
            </div>
          </article>
        ) : (
          <Outlet />
        )}
      </SidebarInset>
      <CommandPalette />
    </>
  )
}
