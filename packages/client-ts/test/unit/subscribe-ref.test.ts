import { describe, expect, it } from "vitest"
import { Effect, SubscriptionRef } from "effect"
import { subscribeRef } from "../../project/store"

// subscribeRef backs ProjectStoreApi.subscribe. Testing it against a plain
// SubscriptionRef exercises the exact delivery + teardown path the store method
// delegates to, without standing up a live backend.
describe("subscribeRef", () => {
  it("delivers the current value immediately, then subsequent changes, and stops after unsubscribe", async () => {
    const received: Array<number> = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ref = yield* SubscriptionRef.make(0)
          const scope = yield* Effect.scope
          const unsubscribe = yield* subscribeRef(ref, scope, (v) => {
            received.push(v)
          })

          // The forked fiber emits the current value (0) first.
          yield* Effect.sleep("50 millis")
          yield* SubscriptionRef.set(ref, 1)
          yield* Effect.sleep("50 millis")
          yield* SubscriptionRef.set(ref, 2)
          yield* Effect.sleep("50 millis")

          // After unsubscribe, further changes must not be delivered.
          unsubscribe()
          yield* Effect.sleep("50 millis")
          yield* SubscriptionRef.set(ref, 3)
          yield* Effect.sleep("50 millis")

          return [...received]
        })
      )
    )

    expect(result).toEqual([0, 1, 2])
  })
})
