import { Context, Effect, Layer } from "effect"
import { AutomationNotification, AutomationNotificationStatus, LocalId, PersonalScope, PositiveVersion } from "@expand/contracts/automation"
import { SqlClient } from "effect/sql/SqlClient"
import { DatabaseReady } from "../migrations/sqlite.js"
import { decode, encodeJson, guard, readJson, same, protectStorage, StorageError } from "./persistence-models.js"

export interface NotificationRecord {
  readonly value: typeof AutomationNotification.Type
  readonly version: number
  readonly sequence: number
}

export interface NotificationListQuery {
  readonly status?: "pending" | "read"
  readonly limit: number
}

export class NotificationRepository extends Context.Service<NotificationRepository, {
  readonly upsert: (notification: typeof AutomationNotification.Type) => Effect.Effect<number, StorageError>
  readonly get: (scope: PersonalScope, runId: string) => Effect.Effect<NotificationRecord | null, StorageError>
  readonly list: (scope: PersonalScope, query: NotificationListQuery) => Effect.Effect<ReadonlyArray<NotificationRecord>, StorageError>
  readonly markRead: (scope: PersonalScope, runId: string) => Effect.Effect<NotificationRecord, StorageError>
}>()("expand/NotificationRepository", {
  make: Effect.gen(function* () {
    yield* DatabaseReady
    const sql = yield* SqlClient
    const readRecord = Effect.fn("Notifications.readRecord")(function* (scope: PersonalScope, row: NotificationRow) {
      const value = yield* readJson(AutomationNotification, row.json)
      yield* guard(value.runId === row.run_id && value.routineId === row.routine_id && value.notificationKind === row.kind && value.status === row.status && same(value.scope, scope))
      yield* decode(PositiveVersion, row.version)
      yield* decode(PositiveVersion, row.seq)
      return { value, version: row.version, sequence: row.seq }
    })
    const fetch = Effect.fn("Notifications.fetch")(function* (scope: PersonalScope, runId: string) {
      yield* decode(PersonalScope, scope)
      yield* decode(LocalId, runId)
      const rows = yield* sql<NotificationRow>`SELECT * FROM automation_notifications WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND run_id=${runId}`
      if (!rows[0]) return null
      return yield* readRecord(scope, rows[0])
    })
    const upsert = (notification: typeof AutomationNotification.Type) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      const value = yield* decode(AutomationNotification, notification)
      const scope = value.scope
      const existing = yield* fetch(scope, value.runId)
      if (existing === null) {
        yield* sql`INSERT INTO automation_notifications ${sql.insert({ owner_id: scope.ownerId, project_id: scope.projectId, run_id: value.runId, routine_id: value.routineId, kind: value.notificationKind, status: value.status, version: 1, json: encodeJson(value) })}`
        return 1
      }
      if (same(existing.value, value)) return existing.version
      const preserved = yield* decode(AutomationNotification, { ...value, status: existing.value.status })
      yield* sql`UPDATE automation_notifications SET routine_id=${preserved.routineId}, kind=${preserved.notificationKind}, status=${preserved.status}, version=version+1, json=${encodeJson(preserved)} WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND run_id=${value.runId}`
      return existing.version + 1
    })))
    const get = (scope: PersonalScope, runId: string) => protectStorage(sql.withTransaction(fetch(scope, runId)))
    const list = (scope: PersonalScope, query: NotificationListQuery) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      yield* decode(PersonalScope, scope)
      yield* guard(Number.isSafeInteger(query.limit) && query.limit > 0 && query.limit <= 100)
      if (query.status !== undefined) yield* decode(AutomationNotificationStatus, query.status)
      const rows = query.status === undefined
        ? yield* sql<NotificationRow>`SELECT * FROM automation_notifications WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} ORDER BY seq LIMIT ${query.limit}`
        : yield* sql<NotificationRow>`SELECT * FROM automation_notifications WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND status=${query.status} ORDER BY seq LIMIT ${query.limit}`
      const records: Array<NotificationRecord> = []
      for (const row of rows) records.push(yield* readRecord(scope, row))
      return records as ReadonlyArray<NotificationRecord>
    })))
    const markRead = (scope: PersonalScope, runId: string) => protectStorage(sql.withTransaction(Effect.gen(function* () {
      const current = yield* fetch(scope, runId)
      yield* guard(current !== null, "missing")
      if (current!.value.status === "read") return current!
      const next = yield* decode(AutomationNotification, { ...current!.value, status: "read" as const })
      yield* sql`UPDATE automation_notifications SET status='read', version=version+1, json=${encodeJson(next)} WHERE owner_id=${scope.ownerId} AND project_id=${scope.projectId} AND run_id=${runId}`
      return { value: next, version: current!.version + 1, sequence: current!.sequence }
    })))
    return { upsert, get, list, markRead }
  })
}) {}
export const NotificationRepositoryLayer = Layer.effect(NotificationRepository, NotificationRepository.make)

interface NotificationRow {
  readonly run_id: string
  readonly routine_id: string
  readonly kind: string
  readonly status: string
  readonly version: number
  readonly seq: number
  readonly json: string
}
