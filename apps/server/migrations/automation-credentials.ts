import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export const automationCredentialsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE automation_credentials (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), secret BLOB NOT NULL,
    UNIQUE(owner_id, project_id, id)
  ) STRICT`
  yield* sql`CREATE INDEX idx_automation_credentials_scope ON automation_credentials(owner_id, project_id, seq)`
})
