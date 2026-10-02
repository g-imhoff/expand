export interface SidebarDevice {
  readonly id: string
  readonly name: string
  readonly kind: "local" | "remote"
  readonly status: "online" | "offline"
  readonly sample?: boolean
}

export interface SidebarConversation {
  readonly id: string
  readonly title: string
  readonly teaser: string
  readonly updatedAt: string
  readonly unread: boolean
}

export interface SidebarWorktreeGroup {
  readonly id: string
  readonly worktreeName: string
  readonly branch: string
  readonly conversations: ReadonlyArray<SidebarConversation>
  readonly sample?: boolean
}

export const defaultSidebarDevices: ReadonlyArray<SidebarDevice> = [
  { id: "device-local", name: "This machine", kind: "local", status: "online", sample: true },
  { id: "device-studio", name: "Studio server", kind: "remote", status: "online", sample: true },
  { id: "device-field", name: "Field laptop", kind: "remote", status: "offline", sample: true }
]

export const defaultSidebarWorktrees: ReadonlyArray<SidebarWorktreeGroup> = [
  {
    id: "wt-expand-sidebar",
    worktreeName: "expand-sidebar",
    branch: "fix/issue-21-desktop-sidebar",
    sample: true,
    conversations: [
      {
        id: "conv-sidebar-shape",
        title: "Sidebar three-zone shape",
        teaser: "Rail holds devices, the panel holds the project switcher and the worktree inbox.",
        updatedAt: "09:34 AM",
        unread: true
      },
      {
        id: "conv-sidebar-tokens",
        title: "Sidebar theme tokens",
        teaser: "Tailwind v4 needs the sidebar token family before the block renders correctly.",
        updatedAt: "Yesterday",
        unread: true
      }
    ]
  },
  {
    id: "wt-expand-auth",
    worktreeName: "expand-auth",
    branch: "fix/issue-13-pid-reuse",
    sample: true,
    conversations: [
      {
        id: "conv-auth-review",
        title: "Auth flow review",
        teaser: "Walk through the login states and the expired-token recovery path.",
        updatedAt: "2 days ago",
        unread: false
      }
    ]
  },
  {
    id: "wt-expand-empty",
    worktreeName: "expand-empty",
    branch: "main",
    sample: true,
    conversations: []
  }
]
