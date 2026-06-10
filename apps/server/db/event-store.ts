import { Context, Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { DomainEvent, DomainEventFromJson } from "@yodea/contracts/events/domain"

type StoreError = SqlError | Schema.SchemaError

export class EventStore extends Context.Service<EventStore, {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<void, StoreError>
  readonly readAll: Effect.Effect<ReadonlyArray<DomainEvent>, StoreError>
}>()("yodea/EventStore", {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient

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
      const rows = yield* sql<{ readonly seq: number; readonly stream_id: string; readonly payload: string }>`
        SELECT seq, stream_id, payload FROM events ORDER BY seq ASC
      `
      const events: Array<DomainEvent> = []
      for (const row of rows) {
        const exit = Schema.decodeUnknownExit(DomainEventFromJson)(row.payload)
        if (Exit.isSuccess(exit)) {
          events.push(exit.value)
        } else {
          yield* Effect.logWarning(`skipping undecodable event row seq=${row.seq} stream_id=${row.stream_id} cause=${exit.cause}`)
        }
      }
      return events as ReadonlyArray<DomainEvent>
    })

    return { append, readAll } as const
  })
}) {}

export const EventStoreLayer = Layer.effect(EventStore, EventStore.make)
