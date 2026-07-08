import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream, SubscriptionRef, Schema } from "effect"
import { Project as ProjectClass } from "@expand/contracts/project"
import type { Project } from "@expand/contracts/project"
import { ProjectCreated } from "@expand/contracts/events/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectStore, type ConnectionStatus } from "@expand/client-ts"
import { buildRendererClient } from "@expand/desktop/renderer/rpc/transport"
import type { RendererPortLike } from "@expand/desktop/renderer/rpc/renderer-port"
import { type MainPortLike, runRpcServer } from "@expand/desktop/main/rpc/server"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const fakeStoreLayer = (
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<SequencedEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    status: Effect.runSync(SubscriptionRef.make<ConnectionStatus>("connected")),
    events: Stream.fromPubSub(hub),
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: string) => {
      const project = Schema.decodeUnknownSync(ProjectClass)({
        id: uid(1),
        name,
        directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t"
      })
      return Effect.andThen(
        PubSub.publish(hub, { seq: 1, event: ProjectCreated.make({ projectId: project.id, name: project.name, occurredAt: "t" }) }),
        SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
      )
    },
    renameProject: (id: string, name: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? Schema.decodeUnknownSync(ProjectClass)({ ...p, name }) : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    changeDirectory: (id: string, directory: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? Schema.decodeUnknownSync(ProjectClass)({ ...p, directory }) : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    archiveProject: (id: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? Schema.decodeUnknownSync(ProjectClass)({ ...p, archived: true }) : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    restoreProject: (id: string) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? Schema.decodeUnknownSync(ProjectClass)({ ...p, archived: false }) : p))).pipe(
        Effect.map((cur) => cur.find((p) => p.id === id)!)
      ),
    setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
      SubscriptionRef.updateAndGet(ref, (cur) => cur.map((p) => (p.id === id ? Schema.decodeUnknownSync(ProjectClass)({ ...p, ...patch }) : p))).pipe(
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
    const hub = await Effect.runPromise(PubSub.unbounded<SequencedEvent>())
    const runtime = ManagedRuntime.make(fakeStoreLayer(ref, hub))
    const { server, renderer } = makePortPair()

    const serverScope = await Effect.runPromise(Scope.make())
    runtime.runFork(runRpcServer(server).pipe(Scope.provide(serverScope)))

    const clientScope = await Effect.runPromise(Scope.make())
    const client = await runtime.runPromise(buildRendererClient(renderer).pipe(Scope.provide(clientScope)))

    try {
      const list0 = await runtime.runPromise(client.ProjectList({}))
      const created = await runtime.runPromise(client.ProjectCreate({ name: "omega", ensure: false }))
      const list1 = await runtime.runPromise(client.ProjectList({}))

      expect(list0).toEqual({ projects: [], seq: 0 })
      expect(created).toMatchObject({ created: true, project: { name: "omega" } })
      expect(list1.projects.map((p) => p.name)).toEqual(["omega"])
    } finally {
      await Effect.runPromise(Scope.close(clientScope, Exit.void))
      await Effect.runPromise(Scope.close(serverScope, Exit.void))
      await runtime.dispose()
    }
  })
})
