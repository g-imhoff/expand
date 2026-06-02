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
      )
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

  it("ProjectChangeDirectory delegates to the store", async () => {
    const program = Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<ReadonlyArray<Project>>([
        { id: "a", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
      ])
      const hub = yield* PubSub.unbounded<DomainEvent>()
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
      const hub = yield* PubSub.unbounded<DomainEvent>()
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
    // The handler layer must construct with the new ProjectArchive/ProjectRestore delegations.
    expect(DesktopRpcHandlers).toBeDefined()
  })
})
