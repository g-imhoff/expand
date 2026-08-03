// Deterministic event-script generator + (in Task 3) batched seeding into cached
// SQLite files. Bump GENERATOR_VERSION whenever generated output changes — it is
// part of the cache filename.
import { Console, DateTime, Effect, FileSystem, Layer, Path, Schema, Scope, Stream } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { DomainEventFromJson } from "@expand/contracts/events/domain"
import type { ProjectEvent } from "@expand/contracts/events/project"
import {
  ProjectArchived,
  ProjectCreated,
  ProjectDeleted,
  ProjectDirectoryChanged,
  ProjectMetadataChanged,
  ProjectRenamed,
  ProjectRestored
} from "@expand/contracts/events/project"
import { FOLD_VERSIONS } from "@expand/contracts/fold-version.generated"
import { Project } from "@expand/contracts/project"
import { PROJECTION_NAME } from "@expand/server/application/projections"
import { ProjectEventStore, ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStore, ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ReplayFeed, ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"
import { EVENT_REVISIONS } from "@expand/server/migrations/events"

const GENERATOR_VERSION = 1
const PRNG_SEED = 42
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
const mulberry32 = (seed: number): (() => number) => {
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
    const at = DateTime.formatIso(DateTime.makeUnsafe(BASE_MS + i * 1000))
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
const BASE_MS = 1_767_225_600_000

// Build a layer once (running its acquisition, e.g. DDL) and release it.
export const buildLayerOnce = Effect.fn("Benchmark.buildLayerOnce")(<ROut, E>(layer: Layer.Layer<ROut, E>) =>
  Effect.flatMap(Scope.make(), (scope) => Scope.use(Layer.buildWithScope(layer, scope), scope)).pipe(Effect.asVoid))

const cachePathFor = (path: Path.Path, benchDir: string, scale: string): string =>
  path.join(benchDir, ".cache", `events-${scale}-seed${PRNG_SEED}-g${GENERATOR_VERSION}.db`)

export const ensureSeed = Effect.fn("Benchmark.ensureSeed")(function*(
  scale: string,
  opts?: { readonly reseed?: boolean }
) {
  const count = SCALES[scale]
  if (count === undefined) return yield* Effect.fail(`unknown scale: ${scale} (known: ${Object.keys(SCALES).join(", ")})`)
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const modulePath = yield* pathService.fromFileUrl(new URL(import.meta.url))
  const path = cachePathFor(pathService, pathService.dirname(modulePath), scale)
  yield* fs.makeDirectory(pathService.dirname(path), { recursive: true })
  if ((yield* fs.exists(path)) && opts?.reseed !== true) return path
  yield* Effect.forEach([path, `${path}-wal`, `${path}-shm`], (candidate) => fs.remove(candidate, { force: true }))
  if (count >= 10_000_000) yield* Console.log(`seeding ${scale} (${count.toLocaleString()} events) — expect a few minutes…`)

  const seedSql = SqliteClient.layer({ filename: path })
  const seedDatabase = DatabaseReadyLayer.pipe(Layer.provideMerge(seedSql))
  yield* buildLayerOnce(ProjectEventStoreLayer.pipe(Layer.provide(seedDatabase)))

  const seedRows = Effect.gen(function*() {
    const sql = yield* SqlClient
    const encode = Schema.encodeEffect(DomainEventFromJson)
    let batch: Array<Record<string, unknown>> = []
    for (const event of generateEvents(count)) {
      batch.push({
        stream_id: event.projectId,
        event_type: event._tag,
        event_revision: EVENT_REVISIONS[event._tag],
        payload: yield* encode(event)
      })
      if (batch.length >= 10_000) {
        yield* sql.withTransaction(sql`INSERT INTO events ${sql.insert(batch)}`)
        batch = []
      }
    }
    if (batch.length > 0) yield* sql.withTransaction(sql`INSERT INTO events ${sql.insert(batch)}`)
  })
  yield* seedRows.pipe(Effect.provide(SqliteClient.layer({ filename: path })))

  yield* validateSeed(path, count)
  return path
})

// Loud abort if the seed is bad — numbers from a bad seed are worse than none.
// Decodes first/middle/last chunks through the REAL feed (fail-fast decode, D10).
const validateSeed = Effect.fn("Benchmark.validateSeed")(function*(dbPath: string, expected: number) {
  const row = yield* Effect.gen(function*() {
    const sql = yield* SqlClient
    return (yield* sql<{ readonly c: number; readonly m: number }>`SELECT COUNT(*) AS c, COALESCE(MAX(seq), 0) AS m FROM events`)[0]!
  }).pipe(Effect.provide(SqliteClient.layer({ filename: dbPath })))
  if (row.c !== expected || row.m !== expected) {
    return yield* Effect.fail(`seed validation failed: count=${row.c} maxSeq=${row.m} expected=${expected}`)
  }
  const sampleSize = Math.min(100, expected)
  const sampleAt = (fromSeq: number) =>
    Effect.gen(function* () {
      const feed = yield* ReplayFeed
      return yield* Stream.runFold(Stream.take(feed.read(fromSeq), sampleSize), () => 0, (n) => n + 1)
    })
  const sql = SqliteClient.layer({ filename: dbPath })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const layer = ReplayFeedLayer.pipe(Layer.provide(database))
  const counts = yield* Effect.provide(
    Effect.all([sampleAt(0), sampleAt(Math.floor(expected / 2)), sampleAt(Math.max(0, expected - sampleSize))]),
    layer
  )
  for (const count of counts) {
    if (count !== sampleSize) return yield* Effect.fail(`seed validation failed: sample decoded ${count}/${sampleSize} events`)
  }
})

const maxSeqOf = Effect.fn("Benchmark.maxSeqOf")(function*(dbPath: string) {
  return yield* Effect.gen(function*() {
    const sql = yield* SqlClient
    const row = (yield* sql<{ readonly m: number }>`SELECT COALESCE(MAX(seq), 0) AS m FROM events`)[0]!
    return row.m
  }).pipe(Effect.provide(SqliteClient.layer({ filename: dbPath })))
})

export const deleteCheckpoint = Effect.fn("Benchmark.deleteCheckpoint")(function*(dbPath: string) {
  yield* Effect.gen(function*() {
    const sql = yield* SqlClient
    yield* sql`DELETE FROM projection_state`
  }).pipe(Effect.provide(SqliteClient.layer({ filename: dbPath })))
})

// Plant a correct-by-construction checkpoint at maxSeq - tailLength: fold the
// prefix with the production shared fold, save via the production store.
export const plantCheckpoint = Effect.fn("Benchmark.plantCheckpoint")(function*(dbPath: string, tailLength: number) {
  const target = (yield* maxSeqOf(dbPath)) - tailLength
  const sql = SqliteClient.layer({ filename: dbPath })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const layer = Layer.mergeAll(ProjectEventStoreLayer, ProjectionStateStoreLayer).pipe(Layer.provide(database))
  const program = Effect.gen(function* () {
    const events = yield* ProjectEventStore
    const states = yield* ProjectionStateStore
    const folded = yield* Stream.runFold(
      Stream.takeWhile(events.read(0), (se) => se.seq <= target),
      () => [] as ReadonlyArray<Project>,
      (projects, se) => Project.foldList(projects, se.event)
    )
    const state = yield* Schema.encodeEffect(ProjectsFromJson)(folded).pipe(Effect.orDie)
    yield* states.save(PROJECTION_NAME, { state, lastSeq: target, foldVersion: FOLD_VERSIONS.projects })
  })
  yield* Effect.provide(program, layer)
})
