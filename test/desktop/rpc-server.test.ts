import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import type { Project } from "@yodea/contracts/project"
import { ProjectCreated, type DomainEvent } from "@yodea/contracts/events"
import { type RpcGroup, type RpcMessage } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"
import { makeRpcServer } from "@yodea/desktop/main/rpc/server"
import { buildClient } from "@yodea/desktop/renderer/rpc/client"

type Rpcs = RpcGroup.Rpcs<typeof YodeaRpcs>

const fakeStoreLayer = (
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<DomainEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.fromPubSub(hub),
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      return Effect.andThen(
        PubSub.publish(hub, ProjectCreated.make({ projectId: project.id, name, createdAt: "t" })),
        SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
      )
    }
  })

describe("main RpcServer <-> renderer RpcClient round-trip", () => {
  it("ProjectList/ProjectCreate cross the seam and decode to typed values", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<Project>>([]))
    const hub = await Effect.runPromise(PubSub.unbounded<DomainEvent>())
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // In-memory wiring of the two halves: the client's onFromClient feeds
        // server.write(0, …); the server's onFromServer feeds the client's write.
        // `toClient` is mutable because the two are mutually referential (the
        // server is built before the client's `write` exists).
        let toClient: (m: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () => Effect.void
        const server = yield* makeRpcServer((response) => toClient(response))
        const { client, write } = yield* buildClient((message) => server.write(0, message))
        toClient = write
        const list0 = yield* client.ProjectList({})
        const created = yield* client.ProjectCreate({ name: "omega", ensure: false })
        const list1 = yield* client.ProjectList({})
        return { list0, created, list1 }
      }).pipe(Effect.provide(fakeStoreLayer(ref, hub)), Effect.scoped)
    )
    expect(result.list0).toEqual([])
    expect(result.created).toMatchObject({ created: true, project: { name: "omega" } })
    expect(result.list1.map((p) => p.name)).toEqual(["omega"])
  })
})
