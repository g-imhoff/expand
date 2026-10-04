import { Context, Effect, Layer } from "effect"
import { SqlError } from "effect/sql/SqlError"
import type { AutomationEvent } from "@expand/contracts/events/automation"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { EventBus } from "@expand/server/application/event-bus"
import { specializeEventStore } from "@expand/server/db/event-store"

export class AutomationEventStore extends Context.Service<AutomationEventStore, {
  readonly append: (event: AutomationEvent) => Effect.Effect<number, SqlError>
}>()("expand/AutomationEventStore", {
  make: specializeEventStore((store) => ({
    append: (event: AutomationEvent) => store.append(event.projectId, event)
  }))
}) {}

export const AutomationEventStoreLayer = Layer.effect(AutomationEventStore, AutomationEventStore.make)

export const emitAutomationEvent = Effect.fn("AutomationEvents.emit")(function*(
  event: AutomationEvent
) {
  const store = yield* AutomationEventStore
  const bus = yield* EventBus
  const sequenced: SequencedEvent = { seq: yield* store.append(event), event }
  yield* bus.publish(sequenced)
  return sequenced
})
