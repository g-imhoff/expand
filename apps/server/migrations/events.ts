import { Data, Effect, Schema } from "effect"
import { DomainEvent } from "@expand/contracts/events/domain"

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
}> {
  get message(): string {
    return `undecodable event row seq=${this.input.seq} stream_id=${this.input.streamId} event_type=${this.input.eventType} stored_revision=${this.input.eventRevision} target_revision=${this.targetRevision ?? "unknown"} failed_revision=${this.failedRevision ?? "unknown"} reason=${this.reason}`
  }
}

export const EVENT_REVISIONS = {
  ProjectCreated: 2,
  ProjectRenamed: 1,
  ProjectDirectoryChanged: 1,
  ProjectArchived: 1,
  ProjectRestored: 1,
  ProjectMetadataChanged: 1,
  ProjectDeleted: 1
} as const satisfies Record<DomainEvent["_tag"], number>

export type EventRevisionRegistry = Readonly<Record<string, number>>
export type EventUpcaster = (payload: Readonly<Record<string, unknown>>) => unknown
export type EventUpcasterRegistry = Readonly<Record<string, Readonly<Record<number, EventUpcaster>>>>

export const EVENT_UPCASTERS = {
  ProjectCreated: { 1: projectCreatedFromRevision1 },
  ProjectRenamed: {},
  ProjectDirectoryChanged: {},
  ProjectArchived: {},
  ProjectRestored: {},
  ProjectMetadataChanged: {},
  ProjectDeleted: {}
} as const satisfies EventUpcasterRegistry

export const decodeStoredEventWithRegistry = Effect.fn("StoredEvent.decodeWithRegistry")(function*(
  input: StoredEventInput,
  revisions: EventRevisionRegistry,
  upcasters: EventUpcasterRegistry
): Effect.fn.Return<DomainEvent, StoredEventMigrationError> {
  const targetRevision = revisions[input.eventType]
  if (targetRevision === undefined) {
    return yield* new StoredEventMigrationError({ input, reason: "unknown-event" })
  }
  if (!Number.isInteger(input.eventRevision) || input.eventRevision <= 0) {
    return yield* new StoredEventMigrationError({ input, targetRevision, reason: "invalid-revision" })
  }
  if (input.eventRevision > targetRevision) {
    return yield* new StoredEventMigrationError({ input, targetRevision, reason: "future-revision" })
  }

  let payload = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(input.payload).pipe(
    Effect.mapError((cause) => new StoredEventMigrationError({ input, targetRevision, reason: "invalid-json", cause }))
  )
  if (!isRecord(payload) || payload._tag !== input.eventType) {
    return yield* new StoredEventMigrationError({ input, targetRevision, reason: "invalid-payload" })
  }

  for (let revision = input.eventRevision; revision < targetRevision; revision++) {
    const upcaster = upcasters[input.eventType]?.[revision]
    if (upcaster === undefined) {
      return yield* new StoredEventMigrationError({
        input,
        targetRevision,
        failedRevision: revision,
        reason: "missing-upcaster"
      })
    }
    payload = yield* Effect.try({
      try: () => upcaster(payload as Readonly<Record<string, unknown>>),
      catch: (cause) => new StoredEventMigrationError({
        input,
        targetRevision,
        failedRevision: revision,
        reason: "invalid-payload",
        cause
      })
    })
    if (!isRecord(payload) || payload._tag !== input.eventType) {
      return yield* new StoredEventMigrationError({
        input,
        targetRevision,
        failedRevision: revision,
        reason: "invalid-payload"
      })
    }
  }

  return yield* Schema.decodeUnknownEffect(DomainEvent)(payload).pipe(
    Effect.mapError((cause) => new StoredEventMigrationError({ input, targetRevision, reason: "invalid-payload", cause }))
  )
})

export const decodeStoredEvent = Effect.fn("StoredEvent.decode")((
  input: StoredEventInput
): Effect.Effect<DomainEvent, StoredEventMigrationError> =>
  decodeStoredEventWithRegistry(input, EVENT_REVISIONS, EVENT_UPCASTERS))

const isRecord = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === "object" && input !== null && !Array.isArray(input)

function projectCreatedFromRevision1(payload: Readonly<Record<string, unknown>>): unknown {
  return "directory" in payload ? payload : { ...payload, directory: null }
}
