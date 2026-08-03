# P0 Persistence Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace store-owned SQLite bootstrap DDL with ordered migrations and make every stored event payload revisioned and upcastable.

**Architecture:** An Effect SQL migrator provides a `DatabaseReady` capability before any store is built. The event table stores `event_revision`; one server-owned registry stamps new events and converts legacy JSON through every intermediate revision before the current domain schema decodes it.

**Tech Stack:** TypeScript, Effect 4, `effect/unstable/sql/Migrator`, `@effect/sql-sqlite-node`, Vitest.

## Global Constraints

- Keep migration numbers in `apps/server/migrations` and event revisions out of RPC/domain schemas.
- Use the existing `SqlClient`; do not add a second connection or migration library.
- Existing databases without a migration ledger or `event_revision` must upgrade in place.
- Existing event and projection rows must survive the upgrade byte-for-byte except for the new revision column.
- Unknown future database or event revisions must stop startup/replay with typed context.
- `ProjectCreated` revision 1 lacks `directory`; revision 2 supplies `directory: null` when absent.
- Do not skip corrupt events or partially apply migrations.
- No code comments are added.

---

### Task 1: Add the migration barrier and event upcaster

**Files:**

- Create: `apps/server/migrations/sqlite.ts`
- Create: `apps/server/migrations/events.ts`
- Create: `apps/server/test/integration/database-migrations.test.ts`
- Modify: `apps/server/db/event-store.ts`
- Modify: `apps/server/db/projection-state-store.ts`
- Modify: `apps/server/composition/app.ts`
- Modify: `apps/server/test/integration/event-store.test.ts`
- Modify: `apps/server/test/integration/projection-state-store.test.ts`
- Modify: `apps/server/test/integration/durability-restart.test.ts`
- Modify: every server test layer that directly builds `ReplayFeedLayer`, `ProjectEventStoreLayer`, or `ProjectionStateStoreLayer`

**Interfaces:**

- Produces: `CURRENT_DATABASE_MIGRATION = 1`.
- Produces: `DatabaseReady`, a service with `{ readonly ready: true }`.
- Produces: `migrateDatabase: Effect.Effect<void, MigrationError | SqlError | DatabaseVersionError, SqlClient>`.
- Produces: `DatabaseReadyLayer: Layer.Layer<DatabaseReady, MigrationError | SqlError | DatabaseVersionError, SqlClient>`.
- Produces: `DATABASE_MIGRATIONS`, the record passed directly to `Migrator.fromRecord`.
- Produces: `EVENT_REVISIONS`, a complete `Record<DomainEvent["_tag"], number>` with `ProjectCreated: 2` and every other current tag at `1`.
- Produces: `EVENT_UPCASTERS`, the runtime per-tag and per-source-revision registry.
- Produces: `decodeStoredEvent(input): Effect.Effect<DomainEvent, StoredEventMigrationError>`.
- Produces: `decodeStoredEventWithRegistry(input, revisions, upcasters)` for deterministic chain validation with an injected immutable registry.
- Consumes: `DatabaseReady` in both store constructors before any query is exposed.

- [ ] **Step 1: Write failing migration integration tests**

Create `database-migrations.test.ts` with an in-memory SQLite layer and assertions equivalent to:

```ts
const Sql = SqliteClient.layer({ filename: ":memory:", disableWAL: true })
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(Sql))

it.live("creates the canonical schema and records migration 1", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient
    const eventColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(events)`
    const migrations = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id
    `
    expect(eventColumns.map((column) => column.name)).toContain("event_revision")
    expect(migrations.map((migration) => migration.migration_id)).toEqual([1])
  }).pipe(Effect.provide(Ready)))
```

Add tests that create the legacy `events` and `projection_state` tables plus representative rows before providing `DatabaseReadyLayer`. Assert that migration adds `event_revision = 1`, preserves payload and projection bytes, and remains idempotent on a second run. Add a failure fixture whose migration transaction cannot complete and assert that migration 1 is absent from `effect_sql_migrations`. Insert migration id `2` manually and assert `DatabaseVersionError` reports `current: 1` and `found: 2`.

- [ ] **Step 2: Run the migration tests and confirm the red state**

Run:

```bash
npm exec -- vitest run apps/server/test/integration/database-migrations.test.ts
```

Expected: FAIL because `DatabaseReadyLayer`, the ledger, and `event_revision` do not exist.

- [ ] **Step 3: Implement the migration capability**

In `apps/server/migrations/sqlite.ts`, define these public shapes:

```ts
export const CURRENT_DATABASE_MIGRATION = 1

export class DatabaseVersionError extends Data.TaggedError("DatabaseVersionError")<{
  readonly current: number
  readonly found: number
}> {}

export class DatabaseReady extends Context.Service<DatabaseReady, {
  readonly ready: true
}>()("expand/DatabaseReady") {}
```

Export `DATABASE_MIGRATIONS` as a readonly record whose `"1_initial"` value is the migration effect, and pass that exact record to `Migrator.fromRecord`. The migration must create the current `events` table with `event_revision INTEGER NOT NULL DEFAULT 1`, create `idx_events_stream`, create `projection_state`, inspect `PRAGMA table_info(events)`, and run `ALTER TABLE events ADD COLUMN event_revision INTEGER NOT NULL DEFAULT 1` only for a legacy table. Run `Migrator.make({})`, then query the maximum ledger id and fail with `DatabaseVersionError` when it exceeds `CURRENT_DATABASE_MIGRATION`. Export `DatabaseReadyLayer` as `Layer.effect(DatabaseReady, migrateDatabase.pipe(Effect.as({ ready: true as const })))`.

- [ ] **Step 4: Write failing event revision and replay tests**

Extend `event-store.test.ts` with these cases:

```ts
it.live("stamps new ProjectCreated rows with revision 2", () =>
  Effect.gen(function*() {
    const events = yield* ProjectEventStore
    const sql = yield* SqlClient
    yield* events.append(ProjectCreated.make({ projectId: uid(1), name: "alpha", directory: null, occurredAt: "t1" }))
    const rows = yield* sql<{ readonly event_revision: number }>`SELECT event_revision FROM events`
    expect(rows).toEqual([{ event_revision: 2 }])
  }).pipe(Effect.provide(storeWith())))
```

Insert a revision-1 `ProjectCreated` JSON payload without `directory`, read it through `ReplayFeed`, and expect `directory: null`. Insert revision `3` and expect the replay defect text to contain sequence, stream, tag, stored revision, and target revision. Call `decodeStoredEventWithRegistry` with a cloned registry missing `ProjectCreated[1]` and assert the typed missing-chain error names revision `1`.

- [ ] **Step 5: Run the event tests and confirm the red state**

Run:

```bash
npm exec -- vitest run apps/server/test/integration/event-store.test.ts
```

Expected: FAIL because writes and reads do not use event revisions.

- [ ] **Step 6: Implement the event revision registry**

In `apps/server/migrations/events.ts`, export these exact inputs and outputs:

```ts
export interface StoredEventInput {
  readonly seq: number
  readonly streamId: string
  readonly eventType: string
  readonly eventRevision: number
  readonly payload: string
}

export class StoredEventMigrationError extends Data.TaggedError("StoredEventMigrationError")<{
  readonly input: StoredEventInput
  readonly targetRevision?: number
  readonly failedRevision?: number
  readonly reason: "unknown-event" | "invalid-revision" | "future-revision" | "missing-upcaster" | "invalid-json" | "invalid-payload"
  readonly cause?: unknown
}> {}

export const EVENT_REVISIONS = {
  ProjectCreated: 2,
  ProjectRenamed: 1,
  ProjectDirectoryChanged: 1,
  ProjectArchived: 1,
  ProjectRestored: 1,
  ProjectMetadataChanged: 1,
  ProjectDeleted: 1
} as const satisfies Record<DomainEvent["_tag"], number>
```

Export `EVENT_UPCASTERS` with the `ProjectCreated` revision-1 function. Implement `decodeStoredEventWithRegistry(input, revisions, upcasters)` and define `decodeStoredEvent(input)` by passing the exported runtime registries. Decode stored JSON with `Schema.UnknownFromJsonString`, verify that `_tag` equals `eventType`, reject non-positive integers and future revisions, apply contiguous upcasters, then decode with the current `DomainEvent` schema. The `ProjectCreated` revision-1 upcaster must return the original object when `directory` exists and `{ ...payload, directory: null }` when it does not.

- [ ] **Step 7: Route all event-store reads and writes through the registry**

Change the insert to include `event_revision: EVENT_REVISIONS[event._tag]`. Add `event_revision` to `EventRow` and both scan queries. Replace direct `DomainEventFromJson` decoding with `decodeStoredEvent({ seq, streamId: row.stream_id, eventType: row.event_type, eventRevision: row.event_revision, payload: row.payload })`; convert its typed failure into the existing fail-fast defect with all row and revision fields.

Delete both stores' DDL. Acquire `DatabaseReady` in `specializeEventStore` and `ProjectionStateStore.make`. Update the composition root and every direct test layer to provide one shared `DatabaseReadyLayer` built from the same `SqlClient` layer.

- [ ] **Step 8: Prove legacy restart and projection equivalence**

Extend `durability-restart.test.ts` to create a legacy database with revisionless events, start the server twice, and assert that the rebuilt project contains `directory: null` and that migration 1 appears only once. Keep the existing endpoint, lock, and shutdown behavior unchanged.

- [ ] **Step 9: Run focused and structural verification**

Run:

```bash
npm exec -- vitest run apps/server/test/integration/database-migrations.test.ts apps/server/test/integration/event-store.test.ts apps/server/test/integration/projection-state-store.test.ts apps/server/test/integration/durability-restart.test.ts apps/server/test/integration/snapshot-equivalence.test.ts
npm run typecheck:all
npm run effect:audit
```

Expected: all commands PASS.

- [ ] **Step 10: Commit P0**

```bash
git add apps/server/migrations apps/server/db/event-store.ts apps/server/db/projection-state-store.ts apps/server/composition/app.ts apps/server/test
git commit -m "feat(server): version database and stored events"
```
