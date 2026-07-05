import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"

// A projection's persisted boot accelerator: serialized state + the last folded
// seq + the fold version, fused in ONE row so state and cursor can never
// disagree (the persisted mirror of the C2 invariant). The store is
// projection-agnostic: `state` is a raw JSON string; codecs live with each
// projection. `state` is nullable in the schema — a future SQL-materialized
// projection may keep a checkpoint-only row (state = NULL); `load` reports
// those as null because a snapshot-style consumer cannot resume from them.
export interface ProjectionStateRow {
  readonly state: string
  readonly lastSeq: number
  readonly foldVersion: string
}

export class ProjectionStateStore extends Context.Service<ProjectionStateStore, {
  readonly load: (name: string) => Effect.Effect<ProjectionStateRow | null, SqlError>
  readonly save: (name: string, row: ProjectionStateRow) => Effect.Effect<void, SqlError>
}>()("yodea/ProjectionStateStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_state (
        name         TEXT PRIMARY KEY,
        state        TEXT,
        last_seq     INTEGER NOT NULL,
        fold_version TEXT    NOT NULL
      ) STRICT
    `
    // The single-row `snapshot` table this store replaces was a disposable
    // cache (D7): drop it, no data migration — first boot re-folds once.
    yield* sql`DROP TABLE IF EXISTS snapshot`

    const load = (name: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly state: string | null; readonly last_seq: number; readonly fold_version: string }>`
          SELECT state, last_seq, fold_version FROM projection_state WHERE name = ${name}
        `
        const row = rows[0]
        if (row === undefined || row.state === null) return null
        return { state: row.state, lastSeq: row.last_seq, foldVersion: row.fold_version }
      })

    const save = (name: string, row: ProjectionStateRow) =>
      Effect.asVoid(sql`
        INSERT INTO projection_state ${sql.insert({ name, state: row.state, last_seq: row.lastSeq, fold_version: row.foldVersion })}
        ON CONFLICT (name) DO UPDATE SET state = excluded.state, last_seq = excluded.last_seq, fold_version = excluded.fold_version
      `)

    return { load, save } as const
  })
}) {}

export const ProjectionStateStoreLayer = Layer.effect(ProjectionStateStore, ProjectionStateStore.make)
