import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream, SubscriptionRef } from "effect"
import type { Project } from "@yodea/contracts/project"
import { ProjectCreated, type DomainEvent } from "@yodea/contracts/events"
import { ProjectStore } from "@yodea/client-core"
import { buildClient, type RendererPortLike } from "@yodea/desktop/renderer/rpc/client"
import { type MainPortLike, runRpcServer } from "@yodea/desktop/main/rpc/server"

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
    },
    renameProject: (id: string, name: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, name } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    changeDirectory: (id: string, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, directory } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    archiveProject: (id: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, archived: true } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    restoreProject: (id: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, archived: false } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? { ...p, ...patch } : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    deleteProject: (id: string) =>
      SubscriptionRef.update(ref, (cur) => cur.filter((p) => p.id !== id)).pipe(
        Effect.as({ id, deleted: true } as const)
      )
  })

const makePortPair = (): { server: MainPortLike; renderer: RendererPortLike } => {
  let serverListener: ((e: { data: unknown }) => void) | null = null
  let rendererListener: ((e: { data: unknown }) => void) | null = null
  const deliver = (listener: (() => ((e: { data: unknown }) => void) | null), message: unknown) => {
    const cloned = structuredClone(message)
    queueMicrotask(() => listener()?.({ data: cloned }))
  }
  const server: MainPortLike = {
    postMessage: (message) => deliver(() => rendererListener, message),
    on: (_event, cb) => { serverListener = cb },
    start: () => {}
  }
  const renderer: RendererPortLike = {
    postMessage: (message) => deliver(() => serverListener, message),
    get onmessage() { return rendererListener },
    set onmessage(cb) { rendererListener = cb },
    start: () => {}
  }
  return { server, renderer }
}

describe("main RpcServer <-> renderer RpcClient round-trip (serialized over a cloning port)", () => {
  it("ProjectList/ProjectCreate cross the seam and decode to typed values", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<Project>>([]))
    const hub = await Effect.runPromise(PubSub.unbounded<DomainEvent>())
    const runtime = ManagedRuntime.make(fakeStoreLayer(ref, hub))
    const { server, renderer } = makePortPair()

    const serverScope = await Effect.runPromise(Scope.make())
    runtime.runFork(runRpcServer(server).pipe(Scope.provide(serverScope)))

    const clientScope = await Effect.runPromise(Scope.make())
    const client = await runtime.runPromise(buildClient(renderer).pipe(Scope.provide(clientScope)))

    try {
      const list0 = await runtime.runPromise(client.ProjectList({}))
      const created = await runtime.runPromise(client.ProjectCreate({ name: "omega", ensure: false }))
      const list1 = await runtime.runPromise(client.ProjectList({}))

      expect(list0).toEqual([])
      expect(created).toMatchObject({ created: true, project: { name: "omega" } })
      expect(list1.map((p) => p.name)).toEqual(["omega"])
    } finally {
      await Effect.runPromise(Scope.close(clientScope, Exit.void))
      await Effect.runPromise(Scope.close(serverScope, Exit.void))
      await runtime.dispose()
    }
  })
})
