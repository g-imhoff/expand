import { Context, Effect, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { DomainEvent, DomainEventFromJson, SequencedEvent } from "@yodea/contracts/events/domain"

export const EventScanChunkSize = Context.Reference<number>("yodea/EventScanChunkSize", {
  defaultValue: () => 1000
})

export interface ScanOptions {
  readonly afterSeq?: number
  readonly eventTypes?: ReadonlyArray<string>
}

export interface EventStorePrimitives {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<number, SqlError>
  readonly scan: (options?: ScanOptions) => Stream.Stream<SequencedEvent, SqlError>
}

export const specializeEventStore = <S>(
  build: (store: EventStorePrimitives) => S
): Effect.Effect<S, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const chunkSize = yield* EventScanChunkSize

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

    const decodeRowStrict = (row: EventRow): Effect.Effect<SequencedEvent> =>
      Schema.decodeUnknownEffect(DomainEventFromJson)(row.payload).pipe(
        Effect.mapError((e) =>
          new Error(`undecodable event row seq=${row.seq} stream_id=${row.stream_id} event_type=${row.event_type}: ${e.message}`)
        ),
        Effect.orDie,
        Effect.map((event) => ({ seq: row.seq, event }))
      )

    const fetchChunk = (afterSeq: number, eventTypes: ReadonlyArray<string> | undefined, limit: number) =>
      eventTypes === undefined
        ? sql<EventRow>`
            SELECT seq, stream_id, event_type, payload FROM events
            WHERE seq > ${afterSeq} ORDER BY seq ASC LIMIT ${limit}
          `
        : sql<EventRow>`
            SELECT seq, stream_id, event_type, payload FROM events
            WHERE seq > ${afterSeq} AND ${sql.in("event_type", eventTypes)}
            ORDER BY seq ASC LIMIT ${limit}
          `

    const scan = (options?: ScanOptions): Stream.Stream<SequencedEvent, SqlError> => {
      const eventTypes = options?.eventTypes
      const go = (afterSeq: number): Stream.Stream<SequencedEvent, SqlError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const rows = yield* fetchChunk(afterSeq, eventTypes, chunkSize)
            const events = yield* Effect.forEach(rows, decodeRowStrict)
            const head = Stream.fromIterable(events)
            return rows.length < chunkSize ? head : Stream.concat(head, go(rows[rows.length - 1]!.seq))
          })
        )
      return go(options?.afterSeq ?? 0)
    }

    return build({ append, scan })
  })

export class EventStore extends Context.Service<EventStore, EventStorePrimitives>()("yodea/EventStore", {
  make: specializeEventStore((store) => store)
}) {}

export const EventStoreLayer = Layer.effect(EventStore, EventStore.make)

interface EventRow {
  readonly seq: number
  readonly stream_id: string
  readonly event_type: string
  readonly payload: string
}
