export interface AutomationScope {
  readonly ownerId: string
  readonly projectId: string
}

export const AUTOMATION_OWNER_ID = "local"

export const automationScope = (projectId: string): AutomationScope => ({
  ownerId: AUTOMATION_OWNER_ID,
  projectId
})
