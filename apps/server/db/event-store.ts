import { Context, Effect, Schema, Stream } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { SqlError } from "effect/unstable/sql/SqlError"
import { DomainEvent, DomainEventFromJson, SequencedEvent } from "@expand/contracts/events/domain"

/**
 * The raw event-log capability shape.
 *
 * @remarks
 * Never a service: no tag, no layer, no context entry. Values of this type
 * exist only inside a {@link specializeEventStore} builder callback — the one
 * door through which a new event family gains storage access.
 */
export interface EventStorePrimitives {
  /**
   * Durably appends one event to a stream.
   *
   * @remarks
   * An encoding failure is a defect (`orDie`), never a typed error.
   *
   * @param streamId - Aggregate identity the event belongs to (e.g. a project id).
   * @param event - The domain event to persist.
   * @returns The event's global, monotonically increasing sequence number.
   */
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<number, SqlError>
  /**
   * Reads the log as a lazy, seq-ascending stream.
   *
   * @remarks
   * Keyset pagination: each pull fetches one chunk ({@link EventScanChunkSize}
   * rows) in its own short read transaction — WAL-friendly. Decoding is
   * fail-fast: an undecodable row is a defect naming `{seq, stream_id,
   * event_type}`, never skipped. Not a snapshot: an event appended between
   * chunk fetches surfaces exactly once, in order — no gap, no duplicate
   * across chunk seams.
   *
   * @param options - Cursor and event-type filter; see {@link ScanOptions}.
   * @returns A stream of sequenced events, strictly after `options.afterSeq`.
   */
  readonly scan: (options?: ScanOptions) => Stream.Stream<SequencedEvent, SqlError>
}

/**
 * Chunk granularity for keyset scans.
 *
 * @remarks
 * Read once when a store is built, not per call. Production always runs the
 * default; tests and the bench override it via
 * `Layer.succeed(EventScanChunkSize, n)`. A tuning knob, not a capability —
 * overriding it is semantics-preserving.
 *
 * @defaultValue 1000
 */
export const EventScanChunkSize = Context.Reference<number>("expand/EventScanChunkSize", {
  defaultValue: () => 1000
})

/** Options for {@link EventStorePrimitives.scan}. */
export interface ScanOptions {
  /**
   * Strictly exclusive lower bound: only events with `seq > afterSeq` are emitted.
   *
   * @defaultValue 0 (the whole log)
   */
  readonly afterSeq?: number
  /**
   * SQL-side event-type filter, checked against the `DomainEvent` union at
   * compile time.
   *
   * @defaultValue undefined (no filter — every event type)
   */
  readonly eventTypes?: ReadonlyArray<DomainEvent["_tag"]>
}

/**
 * The only door to the raw event-log primitives.
 *
 * @remarks
 * Ensures the `events` DDL (idempotent), captures {@link EventScanChunkSize}
 * once, then builds the raw {@link EventStorePrimitives} as a closure handed
 * only to `build`. Calling this IS the sanctioned architectural act of
 * declaring a new specialized event store — misuse is loud and greppable.
 *
 * @example ReplayFeed — the unfiltered, seq-ordered feed
 * ```ts
 * class ReplayFeed extends Context.Service<ReplayFeed, {
 *   readonly read: (fromSeq: number) => Stream.Stream<SequencedEvent, SqlError>
 * }>()("expand/ReplayFeed", {
 *   make: specializeEventStore((store) => ({
 *     read: (fromSeq) => store.scan({ afterSeq: fromSeq })
 *   }))
 * }) {}
 * ```
 *
 * @param build - Receives the raw primitives; returns the specialized store's service value.
 * @returns An effect yielding the specialized store `S`; requires `SqlClient`.
 */
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

interface EventRow {
  readonly seq: number
  readonly stream_id: string
  readonly event_type: string
  readonly payload: string
}
