import { Context, Effect, Exit, Layer, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { DomainEvent, DomainEventFromJson, SequencedEvent } from "@yodea/contracts/events/domain"

export interface ScanOptions {
  readonly afterSeq?: number
  readonly eventTypes?: ReadonlyArray<string>
  /** Test seam: shrink to exercise chunk seams cheaply. Production callers omit it. */
  readonly chunkSize?: number
}

export class EventStore extends Context.Service<EventStore, {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<number, SqlError>
  readonly readAll: Effect.Effect<ReadonlyArray<SequencedEvent>, SqlError>
  readonly readFrom: (fromSeq: number) => Effect.Effect<ReadonlyArray<SequencedEvent>, SqlError>
  readonly scan: (options?: ScanOptions) => Stream.Stream<SequencedEvent, SqlError>
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

    // Fail-fast decode (design D10): an undecodable row is a defect carrying full
    // row context. Recovery is a code fix (restore decodability), never data surgery.
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

    // Keyset pagination: each chunk is one short SQL read (WAL-friendly — no
    // long-lived read transaction pinning the WAL end-mark). The recursion builds
    // lazy stream descriptions; SQL runs only as the consumer pulls.
    const scan = (options?: ScanOptions): Stream.Stream<SequencedEvent, SqlError> => {
      const chunkSize = options?.chunkSize ?? EVENT_SCAN_CHUNK_SIZE
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

    return { append, readAll, readFrom, scan } as const
  })
}) {}

export const EventStoreLayer = Layer.effect(EventStore, EventStore.make)

const EVENT_SCAN_CHUNK_SIZE = 1000

interface EventRow {
  readonly seq: number
  readonly stream_id: string
  readonly event_type: string
  readonly payload: string
}
