import { useState, type CSSProperties } from "react"
import { useCanGoBack, useRouter } from "@tanstack/react-router"
import { ArrowLeft, ChevronRight, Link2, Palette, PanelLeft, Server } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from "@expand/desktop/renderer/components/ui/sidebar"
import { ConnectionSettingsPage } from "@expand/desktop/renderer/features/settings/components/ConnectionSettingsPage"
import { AppearanceSettingsPage } from "@expand/desktop/renderer/features/settings/components/AppearanceSettingsPage"
import { useConnectionSettings } from "@expand/desktop/renderer/features/settings/data/use-connection-settings"

export const SettingsPage = () => {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const { isMobile, open, openMobile, setOpenMobile, toggleSidebar, mobileTriggerRef } = useSidebar()
  const [section, setSection] = useState<"connections" | "backend" | "appearance">("connections")
  const title = section === "connections" ? "Connections" : section === "backend" ? "Backend" : "Appearance"

  return (
    <section
      aria-label="Settings"
      className="flex h-dvh w-full min-w-0 overflow-hidden"
      style={{ "--sidebar-width": "14rem" } as CSSProperties}
    >
      <Sidebar collapsible="icon">
        <div className="flex h-full w-full flex-col">
          <SidebarHeader className="h-16 justify-center">
            <SidebarMenuButton
              type="button"
              aria-label="Back"
              tooltip="Back"
              onClick={() => {
                if (canGoBack) router.history.back()
                else void router.navigate({ to: "/" })
              }}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Settings</SidebarGroupLabel>
              <SidebarGroupContent>
                <nav aria-label="Settings sections">
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label="Connections"
                        tooltip="Connections"
                        isActive={section === "connections"}
                        aria-current={section === "connections" ? "true" : undefined}
                        onClick={() => {
                          setSection("connections")
                          setOpenMobile(false)
                        }}
                      >
                        <Link2 aria-hidden="true" />
                        <span>Connections</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label="Backend"
                        tooltip="Backend"
                        isActive={section === "backend"}
                        aria-current={section === "backend" ? "true" : undefined}
                        onClick={() => {
                          setSection("backend")
                          setOpenMobile(false)
                        }}
                      >
                        <Server aria-hidden="true" />
                        <span>Backend</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label="Appearance"
                        tooltip="Appearance"
                        isActive={section === "appearance"}
                        aria-current={section === "appearance" ? "true" : undefined}
                        onClick={() => {
                          setSection("appearance")
                          setOpenMobile(false)
                        }}
                      >
                        <Palette aria-hidden="true" />
                        <span>Appearance</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </nav>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </div>
      </Sidebar>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-4 border-b px-4">
          <button
            ref={mobileTriggerRef}
            type="button"
            aria-label="Toggle settings sidebar"
            aria-expanded={isMobile ? openMobile : open}
            onClick={toggleSidebar}
            className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeft className="size-4" aria-hidden="true" />
          </button>
          <nav aria-label="Breadcrumb">
            <ol className="flex items-center gap-2 text-sm">
              <li className="text-muted-foreground">Settings</li>
              <li aria-hidden="true"><ChevronRight className="size-4 text-muted-foreground" /></li>
              <li aria-current="page">{title}</li>
            </ol>
          </nav>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto w-full max-w-3xl">
            <SettingsContent section={section} />
          </div>
        </div>
      </main>
    </section>
  )
}

const SettingsContent = ({ section }: { readonly section: "connections" | "backend" | "appearance" }) => {
  const binding = useConnectionSettings()
  return (
    <>
      <div hidden={section === "appearance"}>
        <ConnectionSettingsPage
          model={binding.model}
          section={section === "backend" ? "backend" : "connections"}
          oauthUnavailable
          onStartGithubOAuth={() => {}}
          onPushToGh={() => {}}
          onSaveZenKey={binding.saveZenKey}
          onTestConnection={binding.testConnection}
          onRetry={binding.retry}
        />
      </div>
      {section === "appearance" && <AppearanceSettingsPage />}
    </>
  )
}
