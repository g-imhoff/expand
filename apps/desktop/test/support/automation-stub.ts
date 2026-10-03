import { Effect } from "effect"
import { type AutomationClientApi } from "@expand/client-ts/automation"

export const unusedAutomationClient: AutomationClientApi = {
  routineCreate: () => Effect.die("unused"),
  routineEdit: () => Effect.die("unused"),
  routineEnable: () => Effect.die("unused"),
  routinePause: () => Effect.die("unused"),
  routineDelete: () => Effect.die("unused"),
  routineGet: () => Effect.die("unused"),
  routineList: () => Effect.die("unused"),
  integrationPut: () => Effect.die("unused"),
  integrationGet: () => Effect.die("unused"),
  integrationStatus: () => Effect.die("unused"),
  credentialPut: () => Effect.die("unused"),
  credentialRemove: () => Effect.die("unused"),
  credentialList: () => Effect.die("unused"),
  previewClassification: () => Effect.die("unused"),
  runList: () => Effect.die("unused"),
  runGet: () => Effect.die("unused"),
  runMetrics: () => Effect.die("unused"),
  notificationList: () => Effect.die("unused"),
  notificationMarkRead: () => Effect.die("unused"),
  catalog: () => Effect.die("unused")
}
