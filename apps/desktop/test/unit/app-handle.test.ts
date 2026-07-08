import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream, Schema } from "effect"
import { ProjectCreated } from "@expand/contracts/events/project"
import { Project as ProjectClass } from "@expand/contracts/project"
import type { Project } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { ProjectRpc, type ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"
import { RendererProjectStore, RendererProjectStoreLayer } from "@expand/desktop/renderer/features/projects/data/project-store"
import { makeAppHandle } from "@expand/desktop/renderer/app/app-handle"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const project: Project = Schema.decodeUnknownSync(ProjectClass)({
  id: uid(1), name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t"
})

const stub = (events: ReadonlyArray<SequencedEvent>): Layer.Layer<ProjectRpc> =>
  Layer.succeed(ProjectRpc, {
    create: () => Effect.succeed({ created: true, project }),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.succeed({ projects: [], seq: 0 }),
    events: () => Stream.fromIterable(events)
  } satisfies ProjectRpcApi)

describe("makeAppHandle", () => {
  it("mirrors store.projects into a sync snapshot and notifies subscribers; command resolves via the runtime", async () => {
    const events = [{ seq: 1, event: ProjectCreated.make({ projectId: uid(1), name: "alpha", occurredAt: "t" }) }]
    await Effect.gen(function* () {
      const store = yield* RendererProjectStore
      const context = yield* Effect.context<never>()
      const handle = makeAppHandle(store, context)

      let notified = 0
      const unsubscribe = handle.subscribe(() => { notified += 1 })
      yield* Effect.sleep("20 millis") // let the forked event subscriber + changes mirror run

      expect(handle.getProjects().map((p) => p.name)).toEqual(["alpha"])
      expect(notified).toBeGreaterThan(0)

      const created = yield* Effect.promise(() => handle.createProject("alpha"))
      expect(created.id).toBe(uid(1))
      unsubscribe()
    }).pipe(Effect.scoped, Effect.provide(RendererProjectStoreLayer), Effect.provide(stub(events)), Effect.runPromise)
  })
})
