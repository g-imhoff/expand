import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { DomainEvent, DomainEventFromJson } from "@yodea/contracts/events/domain"

// The store's effects can fail when SQL execution errors (`SqlError`) or when a
// payload fails to (de)serialize through the schema codec (`SchemaError`).
type StoreError = SqlError | Schema.SchemaError

export class EventStore extends Context.Service<EventStore, {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<void, StoreError>
  readonly readAll: Effect.Effect<ReadonlyArray<DomainEvent>, StoreError>
}>()("yodea/EventStore", {
  // Requires SqlClient in context — provided by composition (file db) or tests (:memory:).
  make: Effect.gen(function* () {
    const sql = yield* SqlClient

    // Foundation schema: one append-only table. seq is the monotonic global order.
    yield* sql`
      CREATE TABLE IF NOT EXISTS events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id  TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT
    `
    yield* sql`CREATE INDEX IF NOT EXISTS idx_events_stream ON events (stream_id, seq)`

    const append = (streamId: string, event: DomainEvent) =>
      Effect.gen(function* () {
        const payload = yield* Schema.encodeEffect(DomainEventFromJson)(event)
        yield* sql`INSERT INTO events ${sql.insert({
          stream_id: streamId,
          event_type: event._tag,
          payload
        })}`
      })

    const readAll = Effect.gen(function* () {
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT payload FROM events ORDER BY seq ASC
      `
      return yield* Effect.forEach(rows, (r) =>
        Schema.decodeUnknownEffect(DomainEventFromJson)(r.payload)
      )
    })

    return { append, readAll } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire the layer from the stored `make` constructor.
export const EventStoreLayer = Layer.effect(EventStore, EventStore.make)
