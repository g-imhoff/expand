import { DateTime, Effect } from "effect"
import type { PersonalScope } from "@expand/contracts/automation"
import { AutomationNotification } from "@expand/contracts/automation"
import type { ConfigurationRepository } from "./configuration-repository.js"
import type { ExecutionRepository } from "./execution-repository.js"
import type { NotificationRepository } from "./notification-repository.js"
import { evaluateNotificationKind, notificationMessageFor, notificationTitleFor } from "./notification-policy.js"

export interface NotificationEmitServices {
  readonly executions: ExecutionRepository["Service"]
  readonly configurations: ConfigurationRepository["Service"]
  readonly notifications?: NotificationRepository["Service"]
}

export const emitNotificationForRun = Effect.fn("AutomationNotifications.emit")(function* (
  services: NotificationEmitServices,
  scope: PersonalScope,
  runId: string
) {
  const notifications = services.notifications
  if (notifications === undefined) return
  const current = yield* services.executions.getRun(scope, runId)
  if (current === null) return
  const run = current.value
  if (run.mode !== "live") return
  const revision = yield* services.configurations.getRevision(scope, run.configuration.routineId, run.configuration.revision)
  if (revision === null) return
  const kind = evaluateNotificationKind(revision.configuration, run.state)
  if (kind === null) return
  const occurredAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
  const notification = AutomationNotification.make({
    schemaVersion: 1,
    kind: "notification",
    runId: run.id,
    routineId: run.configuration.routineId,
    scope,
    notificationKind: kind,
    status: "pending",
    title: notificationTitleFor(kind, run.configuration.routineId),
    message: notificationMessageFor(kind, run.state),
    occurredAt
  })
  yield* notifications.upsert(notification)
})
