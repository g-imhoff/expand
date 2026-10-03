import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export const automationGmailMigration = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE automation_gmail_poll_state (
    owner_id TEXT NOT NULL, project_id TEXT NOT NULL, integration_id TEXT NOT NULL,
    history_id TEXT, seen_json TEXT NOT NULL,
    UNIQUE(owner_id, project_id, integration_id)
  ) STRICT`
  yield* sql`CREATE TABLE automation_gmail_sent (
    owner_id TEXT NOT NULL, project_id TEXT NOT NULL, integration_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    UNIQUE(owner_id, project_id, integration_id, message_id)
  ) STRICT`
  yield* sql`CREATE INDEX idx_automation_gmail_poll_scope ON automation_gmail_poll_state(owner_id, project_id, integration_id)`
  yield* sql`CREATE INDEX idx_automation_gmail_sent_scope ON automation_gmail_sent(owner_id, project_id, integration_id)`
})
