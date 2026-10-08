export interface AutomationScope {
  readonly ownerId: string
  readonly projectId: string
}

export {
  automationScope
}

const AUTOMATION_OWNER_ID = "local"

const automationScope = (projectId: string): AutomationScope => ({
  ownerId: AUTOMATION_OWNER_ID,
  projectId
})
