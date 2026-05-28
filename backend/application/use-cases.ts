import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { Session } from "@yodea/shared/session"
import { EventStore } from "@yodea/db/event-store"
import { EventBus } from "@yodea/application/event-bus"
import { SessionProjection } from "@yodea/application/projections"
import { SessionCreated } from "@yodea/shared/events"
import { newId } from "@yodea/lib/ids"

// The commit path appends to the EventStore and the read path rebuilds the
// projection — both inherit the store's failure modes (SQL execution + codec).
type UseCaseError = SqlError | Schema.SchemaError

export class UseCases extends Context.Service<UseCases, {
  readonly health: Effect.Effect<string>
  readonly createSession: (title: string) => Effect.Effect<Session, UseCaseError>
  readonly listSessions: Effect.Effect<ReadonlyArray<Session>, UseCaseError>
}>()("yodea/UseCases", {
  make: Effect.gen(function* () {
    const store = yield* EventStore
    const bus = yield* EventBus
    const projection = yield* SessionProjection

    const health = Effect.succeed("ok")

    // Commit path: durable append (source of truth) THEN live publish.
    // Append is the commit point; publish is best-effort live fan-out.
    const createSession = (title: string) =>
      Effect.gen(function* () {
        const id = newId()
        const createdAt = new Date().toISOString()
        const event = SessionCreated.make({ sessionId: id, title, createdAt })
        yield* store.append(id, event)
        yield* bus.publish(event)
        return { id, title, createdAt }
      })

    const listSessions = projection.list

    return { health, createSession, listSessions } as const
  })
}) {}

// v4 has no auto `.Default` layer — wire it manually with Layer.effect.
export const UseCasesLayer = Layer.effect(UseCases, UseCases.make)
