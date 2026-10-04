import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { Effect, Exit } from "effect"
import { useRendererRunner } from "@expand/desktop/renderer/app/runner-context"
import type { AutomationRpc } from "@expand/desktop/renderer/rpc/automation-rpc"
import { notificationHistoryPath, notificationKindLabel, notificationTone } from "@expand/desktop/renderer/features/automations/model/automation-notifications"
import type { AutomationNotificationView } from "@expand/desktop/renderer/features/automations/model/automation-notifications"

export const AutomationNotifications = ({
  projectId,
  notifications,
  onMarkRead
}: {
  readonly projectId: string
  readonly notifications: ReadonlyArray<AutomationNotificationView>
  readonly onMarkRead: (runId: string) => void
}) => {
  if (notifications.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">No pending notifications.</p>
  }
  return (
    <ul className="mt-4 space-y-3">
      {notifications.map((notification) => (
        <li key={notification.runId} data-testid={`automation-notification-${notification.runId}`} className="rounded-md border p-3">
          <p className={`text-sm font-semibold ${notificationTone(notification.kind)}`}>
            {notificationKindLabel(notification.kind)}: {notification.title}
          </p>
          {notification.message.length > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">{notification.message}</p>
          )}
          <p className="mt-2 flex gap-3 text-sm">
            <Link to={notificationHistoryPath(projectId)} className="underline">
              View run {notification.runId}
            </Link>
            <button type="button" className="underline" onClick={() => onMarkRead(notification.runId)}>
              Mark read
            </button>
          </p>
        </li>
      ))}
    </ul>
  )
}

export const AutomationNotificationsPanel = ({
  projectId,
  scope,
  rpc
}: {
  readonly projectId: string
  readonly scope: { readonly ownerId: string; readonly projectId: string }
  readonly rpc: Pick<AutomationRpc["Service"], "notificationList" | "notificationMarkRead">
}) => {
  const runner = useRendererRunner()
  const [notifications, setNotifications] = useState<ReadonlyArray<AutomationNotificationView>>([])
  useEffect(() => {
    const cancel = runner.start(
      rpc.notificationList({ scope, limit: 50, status: "pending" }).pipe(
        Effect.map((page) =>
          page.notifications.map((record) => ({
            runId: record.notification.runId,
            routineId: record.notification.routineId,
            kind: record.notification.notificationKind,
            title: record.notification.title,
            message: record.notification.message
          }) satisfies AutomationNotificationView)
        )
      ),
      (exit) => {
        if (Exit.isSuccess(exit)) setNotifications(exit.value)
      }
    )
    return cancel
  }, [runner, rpc, scope])
  const markRead = (runId: string) => {
    runner.start(
      rpc.notificationMarkRead({ scope, runId }).pipe(
        Effect.map(() => runId)
      ),
      (exit) => {
        if (Exit.isSuccess(exit)) {
          const readId = exit.value
          setNotifications((current) => current.filter((item) => item.runId !== readId))
        }
      }
    )
  }
  return (
    <section aria-label="Automation notifications">
      <h2 className="text-lg font-semibold">Notifications</h2>
      <AutomationNotifications projectId={projectId} notifications={notifications} onMarkRead={markRead} />
    </section>
  )
}
