import { Context, Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Project } from "@yodea/contracts/project"

const ProjectsFromJson = Schema.fromJsonString(Schema.Array(Project))

export interface Snapshot {
  readonly projects: ReadonlyArray<Project>
  readonly seq: number
  readonly foldVersion: string
}

export class SnapshotStore extends Context.Service<SnapshotStore, {
  readonly load: Effect.Effect<Snapshot | null, SqlError>
  readonly save: (snapshot: Snapshot) => Effect.Effect<void, SqlError>
}>()("yodea/SnapshotStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient

    yield* sql`
      CREATE TABLE IF NOT EXISTS snapshot (
        id           INTEGER PRIMARY KEY CHECK (id = 0),
        projects     TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        fold_version TEXT    NOT NULL
      ) STRICT
    `

    const load = Effect.gen(function* () {
      const rows = yield* sql<{ readonly projects: string; readonly seq: number; readonly fold_version: string }>`
        SELECT projects, seq, fold_version FROM snapshot WHERE id = 0
      `
      const row = rows[0]
      if (row === undefined) return null
      const exit = Schema.decodeUnknownExit(ProjectsFromJson)(row.projects)
      if (Exit.isSuccess(exit)) {
        return { projects: exit.value, seq: row.seq, foldVersion: row.fold_version }
      }
      yield* Effect.logWarning(`snapshot row undecodable — ignoring (will rebuild from log) cause=${exit.cause}`)
      return null
    })

    const save = (snapshot: Snapshot) =>
      Effect.gen(function* () {
        const projects = yield* Schema.encodeEffect(ProjectsFromJson)(snapshot.projects).pipe(Effect.orDie)
        yield* sql`
          INSERT INTO snapshot ${sql.insert({ id: 0, projects, seq: snapshot.seq, fold_version: snapshot.foldVersion })}
          ON CONFLICT (id) DO UPDATE SET projects = excluded.projects, seq = excluded.seq, fold_version = excluded.fold_version
        `
      })

    return { load, save } as const
  })
}) {}

export const SnapshotStoreLayer = Layer.effect(SnapshotStore, SnapshotStore.make)
