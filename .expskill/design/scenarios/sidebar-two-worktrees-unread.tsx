import { useState } from "react"
import { Effect, Schema, Stream } from "effect"
import { Project } from "@expand/contracts/project"
import { SidebarInset, SidebarProvider } from "@expand/desktop/renderer/components/ui/sidebar"
import { ProjectContextProvider, type ProjectContextValue } from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import { AppSidebar } from "@expand/desktop/renderer/features/sidebar/components/AppSidebar"
import type { SidebarDevice, SidebarWorktreeGroup } from "@expand/desktop/renderer/features/sidebar/data/sidebar-data"

export const SidebarScenario = () => {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(projects[0]!.id)
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [activeDeviceId, setActiveDeviceId] = useState(devices[0]!.id)
  const [openedArea, setOpenedArea] = useState("Project inbox")

  return (
    <ProjectContextProvider value={context}>
      <SidebarProvider defaultOpen>
        <AppSidebar
          activeProjectId={activeProjectId}
          onSelectProject={setActiveProjectId}
          activeDeviceId={activeDeviceId}
          onSelectDevice={setActiveDeviceId}
          devices={devices}
          groups={groups}
          activeConversationId={activeConversationId}
          onSelectConversation={setActiveConversationId}
          onOpenAutomations={() => setOpenedArea("Automations")}
          onOpenSettings={() => setOpenedArea("Settings")}
        />
        <SidebarInset>
          <main className="min-w-0 flex-1 p-6" data-sketch-scenario="sidebar-two-worktrees-unread">
            <h1 className="text-xl font-semibold">Project inbox</h1>
            <p className="mt-3 text-sm text-muted-foreground">Two worktrees with read and unread conversations.</p>
            <output className="mt-4 block text-sm" aria-live="polite">{activeConversationId ?? openedArea}</output>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </ProjectContextProvider>
  )
}

const projects = [
  Schema.decodeUnknownSync(Project)({
    id: "00000000-0000-4000-8000-000000000001",
    name: "expand",
    directory: null,
    createdAt: "2026-10-08T09:00:00Z",
    updatedAt: "2026-10-08T09:00:00Z"
  }),
  Schema.decodeUnknownSync(Project)({
    id: "00000000-0000-4000-8000-000000000002",
    name: "docs-site",
    directory: null,
    createdAt: "2026-10-08T09:00:00Z",
    updatedAt: "2026-10-08T09:00:00Z"
  })
]

const store = makeProjectsStore()
store.setState({ projects, seq: 0, status: "connected" })
const unavailable = () => Effect.die(new Error("The design preview has no live project RPC"))
const context: ProjectContextValue = {
  store,
  rpc: {
    create: unavailable,
    rename: unavailable,
    changeDirectory: unavailable,
    archive: unavailable,
    restore: unavailable,
    setMetadata: unavailable,
    delete: unavailable,
    list: () => Effect.succeed({ projects, seq: 0 }),
    status: Stream.never,
    events: () => Stream.never
  }
}

const devices: ReadonlyArray<SidebarDevice> = [
  { id: "device-workstation", name: "Workstation", kind: "local", status: "online" },
  { id: "device-home-server", name: "Home server", kind: "remote", status: "offline" }
]

const groups: ReadonlyArray<SidebarWorktreeGroup> = [
  {
    id: "worktree-client",
    worktreeName: "client-ui",
    branch: "feat/acp-assistant-and-background-responsibilities",
    conversations: [
      {
        id: "conversation-unread",
        title: "Review the sidebar layout and long conversation titles",
        teaser: "Check the project inbox after the latest navigation changes.",
        updatedAt: "09:30 AM",
        unread: true
      },
      {
        id: "conversation-read",
        title: "Check connection settings",
        teaser: "Connection setup now uses the shared account settings.",
        updatedAt: "Yesterday",
        unread: false
      }
    ]
  },
  {
    id: "worktree-server",
    worktreeName: "server-runtime",
    branch: "fix/reconnect-run-outcomes",
    conversations: [
      {
        id: "conversation-server",
        title: "Inspect reconnect behavior",
        teaser: "Confirm that completed and interrupted attempts stay distinguishable.",
        updatedAt: "08:45 AM",
        unread: true
      }
    ]
  }
]
