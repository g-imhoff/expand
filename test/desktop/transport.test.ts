import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, PubSub, Stream, SubscriptionRef } from "effect"
import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { ProjectStore } from "@yodea/client-core"
import { connectPort } from "@yodea/desktop/main/rpc/transport"

// A fake MainPortLike that records start() + the registered message handler.
const makePort = () => {
  const sent: Array<unknown> = []
  let handler: ((e: { data: unknown }) => void) | undefined
  let started = false
  return {
    port: {
      postMessage: (m: unknown) => sent.push(m),
      on: (_ev: "message", cb: (e: { data: unknown }) => void) => { handler = cb },
      start: () => { started = true }
    },
    sent,
    inject: (data: unknown) => handler?.({ data }),
    isStarted: () => started,
    hasHandler: () => handler !== undefined
  }
}

const fakeStoreLayer = (
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<DomainEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.fromPubSub(hub),
    createProject: (name: string) => {
      const p = { id: `id-${name}`, name, createdAt: "t" }
      return SubscriptionRef.update(ref, (c) => [...c, p]).pipe(Effect.as(p))
    }
  })

describe("connectPort", () => {
  it("wires the port (start + message handler) and returns a working teardown", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<Project>>([]))
    const hub = await Effect.runPromise(PubSub.unbounded<DomainEvent>())
    const runtime = ManagedRuntime.make(fakeStoreLayer(ref, hub))
    const p = makePort()
    try {
      const teardown = connectPort({ port: p.port, runtime })
      // let the forked fiber build the server + wire the port
      await new Promise((r) => setTimeout(r, 50))
      expect(p.isStarted()).toBe(true)
      expect(p.hasHandler()).toBe(true)
      expect(typeof teardown).toBe("function")
      await teardown() // resolves: scope closed, fibers interrupted
    } finally {
      await runtime.dispose()
    }
  })
})
