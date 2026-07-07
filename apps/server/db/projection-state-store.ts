import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"

/**
 * One projection's persisted checkpoint.
 *
 * @remarks
 * State, cursor, and fold version are fused in one row so they can never
 * disagree — the persisted mirror of the in-memory `{projects, seq}` pair (C2).
 */
export interface ProjectionStateRow {
  /** The serialized read model — a raw JSON string; the codec lives with the projection. */
  readonly state: string
  /** The log position the state is valid at: every event with `seq <= lastSeq` is folded in. */
  readonly lastSeq: number
  /** Hash of the fold code that produced the state (`FOLD_VERSIONS`); a mismatch at boot forces a rebuild. */
  readonly foldVersion: string
}

/**
 * The projections' boot accelerator: a name-keyed checkpoint table.
 *
 * @remarks
 * A disposable cache, never the source of truth — the event log is. Callers
 * treat a failed `save` as a warning (the next boot just folds a longer tail)
 * and an unusable row as "rebuild from zero"; the fold-version gate is
 * enforced by the consumer, not here. The store is projection-agnostic: it
 * never interprets `state`. Building the layer also drops the legacy
 * single-row `snapshot` table it replaced — no data migration, first boot
 * after the upgrade re-folds once (D7).
 */
export class ProjectionStateStore extends Context.Service<ProjectionStateStore, {
  /**
   * Loads a projection's checkpoint.
   *
   * @remarks
   * Returns `null` for a missing row AND for a `state = NULL` row — the
   * latter is reserved for future SQL-materialized projections that keep a
   * checkpoint-only cursor, which a snapshot-style consumer cannot resume from.
   *
   * @param name - The projection's name (e.g. `"projects"`).
   * @returns The usable checkpoint row, or `null` when a from-zero rebuild is required.
   */
  readonly load: (name: string) => Effect.Effect<ProjectionStateRow | null, SqlError>
  /**
   * Writes a projection's checkpoint as one idempotent UPSERT.
   *
   * @param name - The projection's name.
   * @param row - State + cursor + fold version, persisted atomically in a single statement.
   */
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
