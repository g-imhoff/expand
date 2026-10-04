import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export const automationNotificationsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE automation_notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    run_id TEXT NOT NULL, routine_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('failure','unresolved','success')),
    status TEXT NOT NULL CHECK(status IN ('pending','read')),
    version INTEGER NOT NULL CHECK(version > 0), json TEXT NOT NULL CHECK(json_valid(json)),
    UNIQUE(owner_id, project_id, run_id)
  ) STRICT`
  yield* sql`CREATE INDEX idx_automation_notifications_scope ON automation_notifications(owner_id, project_id, seq)`
  yield* sql`CREATE INDEX idx_automation_notifications_status ON automation_notifications(owner_id, project_id, status, seq)`
})
