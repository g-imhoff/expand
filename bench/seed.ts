// Deterministic event-script generator + (in Task 3) batched seeding into cached
// SQLite files. Bump GENERATOR_VERSION whenever generated output changes — it is
// part of the cache filename.
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DomainEventFromJson } from "@yodea/contracts/events/domain"
import type { ProjectEvent } from "@yodea/contracts/events/project"
import {
  ProjectArchived,
  ProjectCreated,
  ProjectDeleted,
  ProjectDirectoryChanged,
  ProjectMetadataChanged,
  ProjectRenamed,
  ProjectRestored
} from "@yodea/contracts/events/project"
import { FOLD_VERSIONS } from "@yodea/contracts/fold-version.generated"
import { Project } from "@yodea/contracts/project"
import { PROJECTION_NAME } from "@yodea/server/application/projections"
import { ProjectEventStore, ProjectEventStoreLayer } from "@yodea/server/application/projects/project-event-store"
import { foldProjectsInto } from "@yodea/server/domain/project"
import { ProjectionStateStore, ProjectionStateStoreLayer } from "@yodea/server/db/projection-state-store"
import { ReplayFeed, ReplayFeedLayer } from "@yodea/server/db/replay-feed"

export const GENERATOR_VERSION = 1
export const PRNG_SEED = 42
export const LIVE_PROJECT_CAP = 200

export const SCALES: Readonly<Record<string, number>> = {
  smoke: 1_000,
  "100k": 100_000,
  "1m": 1_000_000,
  "10m": 10_000_000
}

// Mirrors the private codec in apps/server/application/projections.ts:13 — the
// planted checkpoint must be decodable by the production boot path.
export const ProjectsFromJson = Schema.fromJsonString(Schema.Array(Project))

// mulberry32 — tiny deterministic PRNG. Same seed → same script, every run.
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Simulated project lifecycles against a capped live population (~LIVE_PROJECT_CAP).
// Cap rationale: tail-fold cost is O(P) per event (Project.foldList maps the whole
// array), so P must stay realistic while the event count explodes.
// IDs are UUID-v4-shaped and names/tags match the Project brand patterns — the
// planted checkpoint is decoded WITH checks at boot (see selfcheck).
export function* generateEvents(count: number, seed: number = PRNG_SEED): Generator<ProjectEvent, void, void> {
  const rand = mulberry32(seed)
  const live: Array<string> = []
  const archived = new Set<string>()
  let nextId = 1
  const pick = (arr: ReadonlyArray<string>): string => arr[Math.floor(rand() * arr.length)]!
  for (let i = 0; i < count; i++) {
    const at = new Date(BASE_MS + i * 1000).toISOString()
    const r = rand()
    if (live.length === 0 || (r < 0.05 && live.length < LIVE_PROJECT_CAP)) {
      const n = nextId++
      const id = uuidOf(n)
      live.push(id)
      yield ProjectCreated.make({ projectId: id, name: `bench-p${n}`, directory: `/bench/p${n}`, occurredAt: at })
    } else {
      const id = pick(live)
      if (r < 0.4) {
        yield ProjectRenamed.make({ projectId: id, name: `bench-r${i % 1000}`, occurredAt: at })
      } else if (r < 0.7) {
        yield ProjectMetadataChanged.make({
          projectId: id,
          description: `bench project description ${i}`,
          tags: ["bench", `t${i % 10}`],
          occurredAt: at
        })
      } else if (r < 0.85) {
        yield ProjectDirectoryChanged.make({ projectId: id, directory: `/bench/dir-${i % 100}`, occurredAt: at })
      } else if (r < 0.92) {
        if (archived.has(id)) {
          archived.delete(id)
          yield ProjectRestored.make({ projectId: id, occurredAt: at })
        } else {
          archived.add(id)
          yield ProjectArchived.make({ projectId: id, occurredAt: at })
        }
      } else if (r < 0.97) {
        if (archived.size > 0) {
          const aid = pick([...archived])
          archived.delete(aid)
          yield ProjectRestored.make({ projectId: aid, occurredAt: at })
        } else {
          yield ProjectMetadataChanged.make({ projectId: id, tags: ["bench"], occurredAt: at })
        }
      } else {
        live.splice(live.indexOf(id), 1)
        archived.delete(id)
        yield ProjectDeleted.make({ projectId: id, occurredAt: at })
      }
    }
  }
}

// UUID-v4-shaped (version nibble 4, variant nibble 8) — passes Schema.isUUID(4).
const uuidOf = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

// Deterministic timestamps: index-derived, never wall-clock.
const BASE_MS = Date.UTC(2026, 0, 1)

// Build a layer once (running its acquisition, e.g. DDL) and release it.
export const buildLayerOnce = <ROut, E>(layer: Layer.Layer<ROut, E>): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(layer, scope)
    yield* Scope.close(scope, Exit.void)
  })

export const cachePathFor = (scale: string): string =>
  join(BENCH_DIR, ".cache", `events-${scale}-seed${PRNG_SEED}-g${GENERATOR_VERSION}.db`)

// Seed (or reuse) the cached DB for a scale. Rows are written with raw batched
// SQL for speed, but payloads come from the REAL DomainEventFromJson encoder and
// the schema comes from the REAL ProjectEventStoreLayer DDL — byte-identical to
// production appends (validated below).
export const ensureSeed = async (scale: string, opts?: { readonly reseed?: boolean }): Promise<string> => {
  const count = SCALES[scale]
  if (count === undefined) throw new Error(`unknown scale: ${scale} (known: ${Object.keys(SCALES).join(", ")})`)
  const path = cachePathFor(scale)
  mkdirSync(join(BENCH_DIR, ".cache"), { recursive: true })
  if (existsSync(path) && opts?.reseed !== true) return path
  for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true })
  if (count >= 10_000_000) console.log(`seeding ${scale} (${count.toLocaleString()} events) — expect a few minutes…`)

  // 1) production DDL — no schema duplication in bench code
  await Effect.runPromise(buildLayerOnce(ProjectEventStoreLayer.pipe(Layer.provide(SqliteClient.layer({ filename: path })))))

  // 2) batched inserts (10k per transaction), payloads via the production codec
  const db = new Database(path)
  db.exec("PRAGMA journal_mode = WAL")
  const insert = db.prepare("INSERT INTO events (stream_id, event_type, payload) VALUES (?1, ?2, ?3)")
  const flush = db.transaction((rows: Array<readonly [string, string, string]>) => {
    for (const r of rows) insert.run(r[0], r[1], r[2])
  })
  const encode = Schema.encodeEffect(DomainEventFromJson)
  let batch: Array<readonly [string, string, string]> = []
  for (const e of generateEvents(count)) {
    batch.push([e.projectId, e._tag, Effect.runSync(encode(e))])
    if (batch.length >= 10_000) {
      flush(batch)
      batch = []
    }
  }
  if (batch.length > 0) flush(batch)
  db.close()

  await validateSeed(path, count)
  return path
}

// Loud abort if the seed is bad — numbers from a bad seed are worse than none.
// Decodes first/middle/last chunks through the REAL feed (fail-fast decode, D10).
export const validateSeed = async (dbPath: string, expected: number): Promise<void> => {
  const db = new Database(dbPath, { readonly: true })
  const row = db.query("SELECT COUNT(*) AS c, COALESCE(MAX(seq), 0) AS m FROM events").get() as { c: number; m: number }
  db.close()
  if (row.c !== expected || row.m !== expected) {
    throw new Error(`seed validation failed: count=${row.c} maxSeq=${row.m} expected=${expected}`)
  }
  const sampleSize = Math.min(100, expected)
  const sampleAt = (fromSeq: number) =>
    Effect.gen(function* () {
      const feed = yield* ReplayFeed
      return yield* Stream.runFold(Stream.take(feed.read(fromSeq), sampleSize), () => 0, (n) => n + 1)
    })
  const layer = ReplayFeedLayer.pipe(Layer.provide(SqliteClient.layer({ filename: dbPath })))
  const counts = await Effect.runPromise(
    Effect.provide(
      Effect.all([sampleAt(0), sampleAt(Math.floor(expected / 2)), sampleAt(Math.max(0, expected - sampleSize))]),
      layer
    )
  )
  for (const c of counts) {
    if (c !== sampleSize) throw new Error(`seed validation failed: sample decoded ${c}/${sampleSize} events`)
  }
}

export const maxSeqOf = (dbPath: string): number => {
  const db = new Database(dbPath, { readonly: true })
  const row = db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }
  db.close()
  return row.m
}

// "No checkpoint" surgery: drop the whole table — the production layer recreates
// it via CREATE IF NOT EXISTS at next boot, so no DDL is duplicated here.
export const deleteCheckpoint = (dbPath: string): void => {
  const db = new Database(dbPath)
  db.run("DROP TABLE IF EXISTS projection_state")
  db.close()
}

// Plant a correct-by-construction checkpoint at maxSeq - tailLength: fold the
// prefix with the production incremental fold, save via the production store.
export const plantCheckpoint = (dbPath: string, tailLength: number): Promise<void> => {
  const target = maxSeqOf(dbPath) - tailLength
  const sql = SqliteClient.layer({ filename: dbPath })
  const layer = Layer.mergeAll(ProjectEventStoreLayer, ProjectionStateStoreLayer).pipe(Layer.provide(sql))
  const program = Effect.gen(function* () {
    const events = yield* ProjectEventStore
    const states = yield* ProjectionStateStore
    const folded = yield* Stream.runFold(
      Stream.takeWhile(events.read(0), (se) => se.seq <= target),
      () => new Map<string, Project>(),
      (byId, se) => {
        foldProjectsInto(byId, se.event)
        return byId
      }
    )
    const state = yield* Schema.encodeEffect(ProjectsFromJson)([...folded.values()]).pipe(Effect.orDie)
    yield* states.save(PROJECTION_NAME, { state, lastSeq: target, foldVersion: FOLD_VERSIONS.projects })
  })
  return Effect.runPromise(Effect.provide(program, layer))
}

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
