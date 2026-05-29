import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Session } from "@yodea/shared/session"
import { EventStore } from "@yodea/db/event-store"
import { projectSessions } from "@yodea/domain/session"

// `list` rebuilds the read-model from the event log, so it inherits the store's
// failure modes (SQL execution + payload codec).
type ProjectionError = SqlError | Schema.SchemaError

export class SessionProjection extends Context.Service<SessionProjection, {
  readonly list: Effect.Effect<ReadonlyArray<Session>, ProjectionError>
}>()("yodea/SessionProjection", {
  // Requires EventStore — provided once by composition (shared instance).
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const list = Effect.map(store.readAll, projectSessions)
    return { list } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire the layer from the stored `make` constructor.
export const SessionProjectionLayer = Layer.effect(SessionProjection, SessionProjection.make)
