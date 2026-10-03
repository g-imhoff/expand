export interface AutomationNotificationView {
  readonly runId: string
  readonly routineId: string
  readonly kind: AutomationNotificationKind
  readonly title: string
  readonly message: string
}

export type AutomationNotificationKind = "failure" | "unresolved" | "success"

export const notificationKindLabel = (kind: AutomationNotificationKind): string => {
  switch (kind) {
  case "failure": return "Failed"
  case "unresolved": return "Needs input"
  case "success": return "Succeeded"
  }
}

export const notificationHistoryPath = (projectId: string): string =>
  `/p/${projectId}/automations/history`

export const notificationTone = (kind: AutomationNotificationKind): string => {
  switch (kind) {
  case "failure": return "text-destructive"
  case "unresolved": return "text-amber-600"
  case "success": return "text-muted-foreground"
  }
}
