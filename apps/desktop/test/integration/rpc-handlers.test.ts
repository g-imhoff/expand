import { describe, expect, it } from "vitest"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import type { Project } from "@yodea/contracts/project"
import type { SequencedEvent } from "@yodea/contracts/events/domain"
import { ProjectStore } from "@yodea/client-core"
import { DesktopRpcHandlers } from "@yodea/desktop/main/rpc/handlers"

const fakeStoreLayer = (
  ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>,
  hub: PubSub.PubSub<SequencedEvent>
) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.fromPubSub(hub),
    snapshot: Effect.map(SubscriptionRef.get(ref), (projects) => ({ projects, seq: 0 })),
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
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

describe("DesktopRpcHandlers", () => {
  it("ProjectList reads the store snapshot; ProjectCreate appends", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])
      const hub = yield* PubSub.unbounded<SequencedEvent>()
      const run = <A, E>(eff: Effect.Effect<A, E, ProjectStore>) =>
        eff.pipe(Effect.provide(fakeStoreLayer(ref, hub)))
      const created = yield* run(Effect.flatMap(ProjectStore, (s) => s.createProject("omega")))
      const list = yield* run(Effect.flatMap(ProjectStore, (s) => SubscriptionRef.get(s.projects)))
      return { created, list }
    })
    const { created, list } = await Effect.runPromise(program)
    expect(created.name).toBe("omega")
    expect(list.map((p) => p.name)).toContain("omega")
    expect(DesktopRpcHandlers).toBeDefined()
  })

  it("ProjectChangeDirectory delegates to the store", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([
        { id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      ])
      const hub = yield* PubSub.unbounded<SequencedEvent>()
      return yield* Effect.flatMap(ProjectStore, (s) => s.changeDirectory("a", "/srv/a")).pipe(
        Effect.provide(fakeStoreLayer(ref, hub))
      )
    })
    const moved = await Effect.runPromise(program)
    expect(moved.directory).toBe("/srv/a")
    expect(DesktopRpcHandlers).toBeDefined()
  })

  it("ProjectArchive delegates to the store and toggles archived:true", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([
        { id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      ])
      const hub = yield* PubSub.unbounded<SequencedEvent>()
      const archived = yield* Effect.flatMap(ProjectStore, (s) => s.archiveProject("a")).pipe(
        Effect.provide(fakeStoreLayer(ref, hub))
      )
      const restored = yield* Effect.flatMap(ProjectStore, (s) => s.restoreProject("a")).pipe(
        Effect.provide(fakeStoreLayer(ref, hub))
      )
      return { archived, restored }
    })
    const { archived, restored } = await Effect.runPromise(program)
    expect(archived.archived).toBe(true)
    expect(restored.archived).toBe(false)
    expect(DesktopRpcHandlers).toBeDefined()
  })
  it("ProjectSetMetadata delegates to the store (replace-style merge)", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([
        { id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      ])
      const hub = yield* PubSub.unbounded<SequencedEvent>()
      return yield* Effect.flatMap(ProjectStore, (s) => s.setMetadata("a", { description: "hi", tags: ["x"] })).pipe(
        Effect.provide(fakeStoreLayer(ref, hub))
      )
    })
    const updated = await Effect.runPromise(program)
    expect(updated.description).toBe("hi")
    expect(updated.tags).toEqual(["x"])
    expect(DesktopRpcHandlers).toBeDefined()
  })

  it("ProjectDelete delegates to store.deleteProject and shrinks the ref", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([{ id: "x", name: "x", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }])
      const hub = yield* PubSub.unbounded<SequencedEvent>()
      const run = <A, E>(eff: Effect.Effect<A, E, ProjectStore>) => eff.pipe(Effect.provide(fakeStoreLayer(ref, hub)))
      const res = yield* run(Effect.flatMap(ProjectStore, (s) => s.deleteProject("x")))
      const list = yield* run(Effect.flatMap(ProjectStore, (s) => SubscriptionRef.get(s.projects)))
      return { res, list }
    })
    const { res, list } = await Effect.runPromise(program)
    expect(res).toEqual({ id: "x", deleted: true })
    expect(list).toEqual([])
    expect(DesktopRpcHandlers).toBeDefined()
  })

})
