import { Context, Effect, Exit, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { DomainEvent, DomainEventFromJson, SequencedEvent } from "@yodea/contracts/events/domain"

export class EventStore extends Context.Service<EventStore, {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<number, SqlError>
  readonly readAll: Effect.Effect<ReadonlyArray<SequencedEvent>, SqlError>
  readonly readFrom: (fromSeq: number) => Effect.Effect<ReadonlyArray<SequencedEvent>, SqlError>
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
        const payload = yield* Schema.encodeEffect(DomainEventFromJson)(event).pipe(Effect.orDie)
        const rows = yield* sql<{ readonly seq: number }>`INSERT INTO events ${sql.insert({
          stream_id: streamId,
          event_type: event._tag,
          payload
        })} RETURNING seq`
        return rows[0]!.seq
      })

    const decodeRows = (
      rows: ReadonlyArray<{ readonly seq: number; readonly stream_id: string; readonly payload: string }>
    ) =>
      Effect.gen(function* () {
        const out: Array<SequencedEvent> = []
        for (const row of rows) {
          const exit = Schema.decodeUnknownExit(DomainEventFromJson)(row.payload)
          if (Exit.isSuccess(exit)) {
            out.push({ seq: row.seq, event: exit.value })
          } else {
            yield* Effect.logWarning(`skipping undecodable event row seq=${row.seq} stream_id=${row.stream_id} cause=${exit.cause}`)
          }
        }
        return out
      })

    const readAll = Effect.flatMap(
      sql<{ readonly seq: number; readonly stream_id: string; readonly payload: string }>`
        SELECT seq, stream_id, payload FROM events ORDER BY seq ASC
      `,
      decodeRows
    )

    const readFrom = (fromSeq: number) =>
      Effect.flatMap(
        sql<{ readonly seq: number; readonly stream_id: string; readonly payload: string }>`
          SELECT seq, stream_id, payload FROM events WHERE seq > ${fromSeq} ORDER BY seq ASC
        `,
        decodeRows
      )

    return { append, readAll, readFrom } as const
  })
}) {}

export const EventStoreLayer = Layer.effect(EventStore, EventStore.make)
