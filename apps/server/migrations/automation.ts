import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export const automationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE automation_integrations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    id TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version > 0),
    version INTEGER NOT NULL CHECK(version > 0), json TEXT NOT NULL CHECK(json_valid(json)),
    UNIQUE(owner_id, project_id, id)
  ) STRICT`
  yield* sql`CREATE TABLE automation_routines (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    id TEXT NOT NULL, head_revision INTEGER NOT NULL CHECK(head_revision > 0),
    status TEXT NOT NULL CHECK(status IN ('enabled','paused','deleted')), version INTEGER NOT NULL CHECK(version > 0),
    UNIQUE(owner_id, project_id, id),
    FOREIGN KEY(owner_id, project_id, id, head_revision) REFERENCES automation_routine_revisions(owner_id, project_id, routine_id, revision) DEFERRABLE INITIALLY DEFERRED
  ) STRICT`
  yield* sql`CREATE TABLE automation_routine_revisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    routine_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), json TEXT NOT NULL CHECK(json_valid(json)),
    UNIQUE(owner_id, project_id, routine_id, revision),
    FOREIGN KEY(owner_id, project_id, routine_id) REFERENCES automation_routines(owner_id, project_id, id)
  ) STRICT`
  yield* sql`CREATE TABLE automation_deliveries (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    id TEXT NOT NULL, integration_id TEXT NOT NULL, external_id TEXT NOT NULL,
    raw BLOB NOT NULL, json TEXT NOT NULL CHECK(json_valid(json)),
    UNIQUE(owner_id, project_id, id), UNIQUE(owner_id, project_id, integration_id, external_id),
    FOREIGN KEY(owner_id, project_id, integration_id) REFERENCES automation_integrations(owner_id, project_id, id)
  ) STRICT`
  yield* sql`CREATE TABLE automation_jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    id TEXT NOT NULL, delivery_id TEXT NOT NULL, routine_id TEXT NOT NULL, revision INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('preview','live')), replay_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','unresolved','failed','cancelled')),
    version INTEGER NOT NULL CHECK(version > 0), json TEXT NOT NULL CHECK(json_valid(json)),
    UNIQUE(owner_id, project_id, id), UNIQUE(owner_id, project_id, delivery_id, routine_id, mode, replay_key),
    UNIQUE(owner_id, project_id, id, delivery_id, routine_id, revision, mode),
    FOREIGN KEY(owner_id, project_id, delivery_id) REFERENCES automation_deliveries(owner_id, project_id, id),
    FOREIGN KEY(owner_id, project_id, routine_id, revision) REFERENCES automation_routine_revisions(owner_id, project_id, routine_id, revision)
  ) STRICT`
  yield* sql`CREATE TABLE automation_runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
    id TEXT NOT NULL, job_id TEXT NOT NULL, delivery_id TEXT NOT NULL, routine_id TEXT NOT NULL, revision INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('preview','live')),
    state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','unresolved','failed','cancelled')),
    version INTEGER NOT NULL CHECK(version > 0), json TEXT NOT NULL CHECK(json_valid(json)),
    UNIQUE(owner_id, project_id, id), UNIQUE(owner_id, project_id, job_id), UNIQUE(owner_id, project_id, id, job_id),
    FOREIGN KEY(owner_id, project_id, job_id, delivery_id, routine_id, revision, mode) REFERENCES automation_jobs(owner_id, project_id, id, delivery_id, routine_id, revision, mode)
  ) STRICT`
  for (const kind of ["job", "decision", "action"]) {
    yield* sql.unsafe(`CREATE TABLE automation_${kind}_attempts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
      id TEXT NOT NULL, run_id TEXT NOT NULL, job_id TEXT NOT NULL, step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt > 0), status TEXT NOT NULL CHECK(status IN ('started','completed')),
      json TEXT NOT NULL CHECK(json_valid(json)), UNIQUE(owner_id, project_id, id),
      UNIQUE(owner_id, project_id, run_id, step_id, attempt),
      FOREIGN KEY(owner_id, project_id, run_id, job_id) REFERENCES automation_runs(owner_id, project_id, id, job_id)
    ) STRICT`)
  }
  for (const name of ["integrations", "routines", "routine_revisions", "deliveries", "jobs", "runs", "job_attempts", "decision_attempts", "action_attempts"]) {
    yield* sql.unsafe(`CREATE INDEX idx_automation_${name}_scope ON automation_${name}(owner_id, project_id, seq)`)
  }
  yield* sql`CREATE INDEX idx_automation_runs_filter ON automation_runs(owner_id, project_id, routine_id, mode, state, seq)`
  yield* sql`CREATE INDEX idx_automation_jobs_filter ON automation_jobs(owner_id, project_id, routine_id, mode, state, seq)`
})
