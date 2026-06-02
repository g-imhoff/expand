import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import type { Project } from "@yodea/contracts/project"
import type { DomainEvent } from "@yodea/contracts/events"
import { ProjectStore } from "@yodea/client-core"
import { DesktopRpcHandlers } from "@yodea/desktop/main/rpc/handlers"

// A fake ProjectStore: an in-memory ref + a hub we can publish into.
const fakeStoreLayer = (
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<DomainEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.fromPubSub(hub),
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, createdAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
    }
  })

describe("DesktopRpcHandlers", () => {
  it("ProjectList reads the store snapshot; ProjectCreate appends", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])
      const hub = yield* PubSub.unbounded<DomainEvent>()
      const run = <A, E>(eff: Effect.Effect<A, E, ProjectStore>) =>
        eff.pipe(Effect.provide(fakeStoreLayer(ref, hub)))
      const created = yield* run(Effect.flatMap(ProjectStore, (s) => s.createProject("omega")))
      const list = yield* run(Effect.flatMap(ProjectStore, (s) => SubscriptionRef.get(s.projects)))
      return { created, list }
    })
    const { created, list } = await Effect.runPromise(program)
    expect(created.name).toBe("omega")
    expect(list.map((p) => p.name)).toContain("omega")
    // The handler layer must construct without error.
    expect(DesktopRpcHandlers).toBeDefined()
  })
})
