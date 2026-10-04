import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
export const automationGmailMigration = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE automation_gmail_poll_state (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    integration_id TEXT NOT NULL, last_history_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(owner_id, project_id, integration_id)
  ) STRICT`
  yield* sql`CREATE TABLE automation_gmail_seen (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    integration_id TEXT NOT NULL, message_id TEXT NOT NULL, seen_at TEXT NOT NULL,
    UNIQUE(owner_id, project_id, integration_id, message_id)
  ) STRICT`
  yield* sql`CREATE TABLE automation_gmail_sent (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    message_id TEXT NOT NULL, sent_at TEXT NOT NULL,
    UNIQUE(owner_id, project_id, message_id)
  ) STRICT`
  yield* sql`CREATE INDEX idx_automation_gmail_poll_state_scope ON automation_gmail_poll_state(owner_id, project_id, seq)`
  yield* sql`CREATE INDEX idx_automation_gmail_seen_scope ON automation_gmail_seen(owner_id, project_id, seq)`
  yield* sql`CREATE INDEX idx_automation_gmail_sent_scope ON automation_gmail_sent(owner_id, project_id, seq)`
})
