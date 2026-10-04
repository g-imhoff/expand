import { Effect } from "effect"
import type { AutomationClientApi } from "@expand/client-ts/automation"

export const unusedAutomationClient: AutomationClientApi = {
  createRoutine: () => Effect.die("unused"),
  editRoutine: () => Effect.die("unused"),
  enableRoutine: () => Effect.die("unused"),
  pauseRoutine: () => Effect.die("unused"),
  deleteRoutine: () => Effect.die("unused"),
  getRoutine: () => Effect.die("unused"),
  listRoutines: () => Effect.die("unused"),
  putIntegration: () => Effect.die("unused"),
  getIntegration: () => Effect.die("unused"),
  integrationStatus: () => Effect.die("unused"),
  putCredential: () => Effect.die("unused"),
  removeCredential: () => Effect.die("unused"),
  listCredentials: () => Effect.die("unused"),
  previewClassification: () => Effect.die("unused"),
  listRuns: () => Effect.die("unused"),
  getRun: () => Effect.die("unused"),
  runMetrics: () => Effect.die("unused"),
  notificationList: () => Effect.die("unused"),
  notificationMarkRead: () => Effect.die("unused"),
  catalog: () => Effect.die("unused")
}
