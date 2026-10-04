import type { AutomationPage } from "@expand/desktop/renderer/features/sidebar/components/AutomationNavigation"

export const automationRoutes = {
  overview: "/p/$projectId/automations",
  integrations: "/p/$projectId/automations/integrations",
  "routine-setup": "/p/$projectId/automations/routines/new",
  "routine-edit": "/p/$projectId/automations/routines/$routineId",
  "routine-test": "/p/$projectId/automations/routines/$routineId/test",
  history: "/p/$projectId/automations/history"
} as const satisfies Record<AutomationPage | "routine-edit" | "routine-test", string>

export const automationPageForPath = (pathname: string): AutomationPage | null => {
  const match = /^\/p\/[^/]+\/automations(?:\/(integrations|routines\/[^/]+(?:\/test)?|history))?\/?$/.exec(pathname)
  if (!match) return null
  const section = match[1]
  if (section === undefined) return "overview"
  if (section === "integrations") return "integrations"
  if (section === "history") return "history"
  return "routine-setup"
}
