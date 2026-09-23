import { useState } from "react"
import {
  Check,
  ChevronsUpDown,
  Command,
  FolderGit2,
  GitBranch,
  Laptop,
  MessageSquare,
  MonitorSmartphone
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@expand/desktop/renderer/components/ui/dropdown-menu"
import { Label } from "@expand/desktop/renderer/components/ui/label"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from "@expand/desktop/renderer/components/ui/sidebar"
import { Switch } from "@expand/desktop/renderer/components/ui/switch"
import { useProjects } from "@expand/desktop/renderer/features/projects/data/use-projects"
import {
  defaultSidebarDevices,
  defaultSidebarWorktrees,
  type SidebarConversation,
  type SidebarDevice,
  type SidebarWorktreeGroup
} from "@expand/desktop/renderer/features/sidebar/data/sidebar-data"

export interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  readonly activeProjectId: string | null
  readonly onSelectProject?: ((projectId: string) => void) | undefined
  readonly devices?: ReadonlyArray<SidebarDevice> | undefined
  readonly activeDeviceId?: string | undefined
  readonly onSelectDevice?: ((deviceId: string) => void) | undefined
  readonly groups?: ReadonlyArray<SidebarWorktreeGroup> | undefined
  readonly activeConversationId?: string | null | undefined
  readonly onSelectConversation?: ((conversationId: string) => void) | undefined
}

export const AppSidebar = ({
  activeProjectId,
  onSelectProject,
  devices = defaultSidebarDevices,
  activeDeviceId,
  onSelectDevice,
  groups = defaultSidebarWorktrees,
  activeConversationId,
  onSelectConversation,
  ...props
}: AppSidebarProps) => {
  const { setOpen } = useSidebar()
  const { data: projects = [] } = useProjects()
  const [internalDeviceId, setInternalDeviceId] = useState<string | undefined>(devices[0]?.id)
  const [internalConversationId, setInternalConversationId] = useState<string | null>(null)
  const [unreadsOnly, setUnreadsOnly] = useState(false)
  const [query, setQuery] = useState("")

  const selectedDeviceId = activeDeviceId ?? internalDeviceId
  const activeDevice = devices.find((device) => device.id === selectedDeviceId) ?? null
  const selectedConversationId = activeConversationId === undefined ? internalConversationId : activeConversationId
  const visibleProjects = projects.filter((p) => !p.archived)
  const activeProject = visibleProjects.find((p) => p.id === activeProjectId) ?? null
  const allDevicesAreSamples = devices.length > 0 && devices.every((device) => device.sample)
  const allGroupsAreSamples = groups.length > 0 && groups.every((group) => group.sample)

  const selectDevice = (deviceId: string) => {
    if (onSelectDevice) {
      onSelectDevice(deviceId)
    } else {
      setInternalDeviceId(deviceId)
    }
    setOpen(true)
  }

  const selectConversation = (conversationId: string) => {
    if (onSelectConversation) {
      onSelectConversation(conversationId)
    } else {
      setInternalConversationId(conversationId)
    }
  }

  const needle = query.trim().toLowerCase()
  const visibleGroups = groups.map((group) => ({
    ...group,
    conversations: group.conversations.filter((conv) => {
      if (unreadsOnly && !conv.unread) return false
      if (needle === "") return true
      return `${conv.title} ${conv.teaser}`.toLowerCase().includes(needle)
    })
  }))
  const visibleCount = visibleGroups.reduce((n, group) => n + group.conversations.length, 0)

  return (
    <Sidebar
      collapsible="icon"
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row"
      {...props}
    >
      <Sidebar
        collapsible="none"
        className="w-[calc(var(--sidebar-width-icon)+1px)]! shrink-0 border-r"
      >
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="md:h-8 md:p-0"
                    aria-label={
                      activeDevice
                        ? `Switch ${activeDevice.sample ? "sample " : ""}device, active: ${activeDevice.name}`
                        : "Switch device"
                    }
                  >
                    <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground [&>svg]:size-4">
                      {activeDevice ? <DeviceIcon device={activeDevice} /> : <Command className="size-4" />}
                    </span>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{activeDevice?.name ?? "Expand"}</span>
                      <span className="truncate text-xs">
                        {activeDevice
                          ? `${activeDevice.sample ? "Sample · " : ""}${activeDevice.status}`
                          : "Desktop"}
                      </span>
                    </span>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>{allDevicesAreSamples ? "Sample devices" : "Devices"}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {devices.length === 0 && (
                    <DropdownMenuItem disabled>No devices yet</DropdownMenuItem>
                  )}
                  {devices.map((device) => {
                    const isActive = device.id === selectedDeviceId
                    return (
                      <DropdownMenuItem
                        key={device.id}
                        onSelect={() => selectDevice(device.id)}
                        aria-current={isActive ? "true" : undefined}
                        className={isActive ? "font-medium" : undefined}
                      >
                        <DeviceIcon device={device} />
                        <span className="grid flex-1 text-left leading-tight">
                          <span className="truncate">{device.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {device.sample ? `Sample · ${device.status}` : device.status}
                          </span>
                        </span>
                        {isActive && <Check className="ml-auto size-4 shrink-0" aria-label="active" />}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        {allDevicesAreSamples && (
          <SidebarFooter className="items-center px-0 text-[10px] text-muted-foreground">
            Sample
          </SidebarFooter>
        )}
      </Sidebar>

      <Sidebar collapsible="none" className="min-w-0 flex-1" aria-label="Project and conversations">
        <SidebarHeader className="gap-3.5 border-b p-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="h-auto border border-sidebar-border py-2"
                aria-label={activeProject ? `Active project: ${activeProject.name}` : "Select a project"}
              >
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <FolderGit2 className="size-4" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{activeProject?.name ?? "Select a project"}</span>
                  <span className="truncate text-xs">Project</span>
                </span>
                <ChevronsUpDown className="ml-auto size-4" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {visibleProjects.length === 0 && (
                <DropdownMenuItem disabled>No projects yet</DropdownMenuItem>
              )}
              {visibleProjects.map((project) => {
                const isActive = project.id === activeProjectId
                return (
                  <DropdownMenuItem
                    key={project.id}
                    onSelect={() => onSelectProject?.(project.id)}
                    aria-current={isActive ? "true" : undefined}
                    className={isActive ? "font-medium" : undefined}
                  >
                    <span className="grid flex-1 text-left leading-tight">
                      <span className="truncate">{project.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {isActive ? "Active project" : project.id}
                      </span>
                    </span>
                    {isActive && <Check className="ml-auto size-4 shrink-0" aria-label="active" />}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex w-full items-center justify-between">
            <div className="text-base font-medium text-foreground">
              {allGroupsAreSamples ? "Sample conversations" : "Conversations"}
            </div>
            <Label className="flex items-center gap-2 text-sm">
              <span>Unreads</span>
              <Switch
                className="shadow-none"
                checked={unreadsOnly}
                onCheckedChange={setUnreadsOnly}
                aria-label="Show unread conversations only"
              />
            </Label>
          </div>
          <SidebarInput
            placeholder="Type to search..."
            aria-label="Search conversations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </SidebarHeader>
        <SidebarContent>
          {visibleCount === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <MessageSquare className="size-6 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">No conversations found</p>
              <p className="text-xs text-muted-foreground">
                {groups.length === 0
                  ? "Start a conversation to fill the inbox."
                  : "Try a different search or turn off the unread filter."}
              </p>
            </div>
          ) : (
            visibleGroups.map((group) =>
              group.conversations.length === 0 ? null : (
                <SidebarGroup key={group.id} className="px-0">
                  <SidebarGroupLabel className="px-4">
                    <GitBranch className="mr-1 size-3.5" aria-hidden />
                    {group.sample && <span className="mr-1 shrink-0 text-[10px]">Sample</span>}
                    <span className="truncate">{group.worktreeName}</span>
                    <span className="ml-1 truncate font-normal text-muted-foreground">{group.branch}</span>
                    <span className="ml-auto pl-2 text-muted-foreground">{group.conversations.length}</span>
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    {group.conversations.map((conversation) => (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        isActive={selectedConversationId === conversation.id}
                        onSelect={() => selectConversation(conversation.id)}
                      />
                    ))}
                  </SidebarGroupContent>
                </SidebarGroup>
              )
            )
          )}
        </SidebarContent>
      </Sidebar>
    </Sidebar>
  )
}

const DeviceIcon = ({ device }: { readonly device: SidebarDevice }) => {
  if (device.kind === "local") return <Laptop aria-hidden />
  return <MonitorSmartphone aria-hidden />
}

const ConversationRow = ({
  conversation,
  isActive,
  onSelect
}: {
  readonly conversation: SidebarConversation
  readonly isActive: boolean
  readonly onSelect: () => void
}) => (
  <button
    type="button"
    onClick={onSelect}
    data-active={isActive}
    aria-current={isActive ? "true" : undefined}
    aria-label={`${conversation.title}${conversation.unread ? ", unread" : ""}`}
    className="flex w-full min-w-0 flex-col items-start gap-2 border-b p-4 text-left text-sm leading-tight whitespace-nowrap last:border-b-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
  >
    <span className="flex w-full items-center gap-2">
      {conversation.unread && (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sidebar-primary" />
      )}
      <span className="truncate font-medium">{conversation.title}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{conversation.updatedAt}</span>
    </span>
    <span className="line-clamp-2 w-full text-xs whitespace-break-spaces text-muted-foreground">
      {conversation.teaser}
    </span>
  </button>
)
