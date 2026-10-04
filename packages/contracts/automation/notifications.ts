import { Schema } from "effect"
import { LocalId, PersonalScope } from "./ids.js"

export const AutomationNotificationKind = Schema.Literals(["failure", "unresolved", "success"])
export type AutomationNotificationKind = typeof AutomationNotificationKind.Type
export const AutomationNotificationStatus = Schema.Literals(["pending", "read"])
export type AutomationNotificationStatus = typeof AutomationNotificationStatus.Type
export const AutomationNotification = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("notification"),
  runId: LocalId,
  routineId: LocalId,
  scope: PersonalScope,
  notificationKind: AutomationNotificationKind,
  status: AutomationNotificationStatus,
  title: Schema.String.check(Schema.isMinLength(1)),
  message: Schema.String,
  occurredAt: Schema.String.check(Schema.isMinLength(1))
})
export type AutomationNotification = typeof AutomationNotification.Type
