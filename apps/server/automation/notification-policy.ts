import type { AutomationRun } from "@expand/contracts/automation"

export type NotificationKind = "failure" | "unresolved" | "success"

export const evaluateNotificationKind = (
  configuration: unknown,
  state: AutomationRun["state"]
): NotificationKind | null => {
  if (state.kind === "failed") return "failure"
  if (state.kind === "unresolved") {
    const preferences = readPreferences(configuration)
    if (preferences !== null && preferences.onNoMatch === false) return null
    return "unresolved"
  }
  if (state.kind === "succeeded") {
    const preferences = readPreferences(configuration)
    if (preferences !== null && preferences.onMatch === true) return "success"
    return null
  }
  return null
}

export const notificationTitleFor = (
  kind: NotificationKind,
  routineId: string
): string => {
  switch (kind) {
  case "failure": return `Automation ${routineId} failed`
  case "unresolved": return `Automation ${routineId} needs input`
  case "success": return `Automation ${routineId} succeeded`
  }
}

export const notificationMessageFor = (
  kind: NotificationKind,
  state: AutomationRun["state"]
): string => {
  if (state.kind === "failed" && kind === "failure") return state.error.message
  if (state.kind === "unresolved" && kind === "unresolved") return state.reason
  return ""
}

interface NotificationPreferences {
  readonly onMatch: boolean | undefined
  readonly onNoMatch: boolean | undefined
}

const readPreferences = (configuration: unknown): NotificationPreferences | null => {
  if (configuration === null || typeof configuration !== "object" || Array.isArray(configuration)) return null
  const notifications = (configuration as Record<string, unknown>)["notifications"]
  if (notifications === null || typeof notifications !== "object" || Array.isArray(notifications)) {
    return (configuration as Record<string, unknown>)["onMatch"] !== undefined || (configuration as Record<string, unknown>)["onNoMatch"] !== undefined
      ? readFlatPreferences(configuration as Record<string, unknown>)
      : null
  }
  return readFlatPreferences(notifications as Record<string, unknown>)
}

const readFlatPreferences = (record: Record<string, unknown>): NotificationPreferences | null => {
  const onMatch = record["onMatch"]
  const onNoMatch = record["onNoMatch"]
  if (onMatch === undefined && onNoMatch === undefined) return null
  return {
    onMatch: typeof onMatch === "boolean" ? onMatch : undefined,
    onNoMatch: typeof onNoMatch === "boolean" ? onNoMatch : undefined
  }
}
