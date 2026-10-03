import type { AutomationPage } from "@expand/desktop/renderer/features/sidebar/components/AutomationNavigation"

export const automationRoutes = {
  overview: "/p/$projectId/automations",
  integrations: "/p/$projectId/automations/integrations",
  "routine-setup": "/p/$projectId/automations/routines/new",
  history: "/p/$projectId/automations/history"
} as const satisfies Record<AutomationPage, string>

export const automationPageForPath = (pathname: string): AutomationPage | null => {
  const match = /^\/p\/[^/]+\/automations(?:\/(integrations|routines\/new|history))?\/?$/.exec(pathname)
  if (!match) return null
  switch (match[1]) {
    case "integrations": return "integrations"
    case "routines/new": return "routine-setup"
    case "history": return "history"
    default: return "overview"
  }
}
