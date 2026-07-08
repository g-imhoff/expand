import { describe, expect, it } from "vitest"
import { Effect, Schema } from "effect"
import { Project as ProjectClass } from "@expand/contracts/project"
import type { Project } from "@expand/contracts/project"
import { RendererRpcClient, type RendererRpcClientApi } from "@expand/desktop/renderer/rpc/transport"
import { ProjectRpc, ProjectRpcLayer } from "@expand/desktop/renderer/rpc/project-rpc"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

type RpcOverrides = { readonly [K in keyof RendererRpcClientApi]?: (payload: Parameters<RendererRpcClientApi[K]>[0]) => unknown }

const fakeClient = (over: RpcOverrides): RendererRpcClientApi =>
  ({
    Health: () => Effect.succeed("ok"),
    ProjectCreate: () => Effect.die("unused"),
    ProjectRename: () => Effect.die("unused"),
    ProjectChangeDirectory: () => Effect.die("unused"),
    ProjectArchive: () => Effect.die("unused"),
    ProjectRestore: () => Effect.die("unused"),
    ProjectSetMetadata: () => Effect.die("unused"),
    ProjectDelete: () => Effect.die("unused"),
    ProjectList: () => Effect.succeed({ projects: [], seq: 0 }),
    Connect: () => Effect.die("unused"),
    Events: () => Effect.die("unused"),
    ...over
  }) as unknown as RendererRpcClientApi

const project: Project = Schema.decodeUnknownSync(ProjectClass)({
  id: uid(1), name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t"
})

describe("ProjectRpcLayer", () => {
  it("create passes the payload straight through to ProjectCreate", async () => {
    const client = fakeClient({
      ProjectCreate: (payload) => {
        expect(payload).toEqual({ name: "alpha", ensure: true })
        return Effect.succeed({ created: true, project })
      }
    })
    const result = await ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.create({ name: "alpha", ensure: true })),
      Effect.provide(ProjectRpcLayer),
      Effect.provideService(RendererRpcClient, client),
      Effect.runPromise
    )
    expect(result).toEqual({ created: true, project })
  })

  it("archive forwards the { id } payload", async () => {
    const client = fakeClient({
      ProjectArchive: (payload) => {
        expect(payload).toEqual({ id: uid(1) })
        return Effect.succeed(project)
      }
    })
    const result = await ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.archive({ id: uid(1) })),
      Effect.provide(ProjectRpcLayer),
      Effect.provideService(RendererRpcClient, client),
      Effect.runPromise
    )
    expect(result).toEqual(project)
  })

  it("list forwards includeArchived (defaulting to {})", async () => {
    const client = fakeClient({
      ProjectList: (payload) => {
        expect(payload).toEqual({ includeArchived: true })
        return Effect.succeed({ projects: [], seq: 0 })
      }
    })
    const result = await ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.list({ includeArchived: true })),
      Effect.provide(ProjectRpcLayer),
      Effect.provideService(RendererRpcClient, client),
      Effect.runPromise
    )
    expect(result).toEqual({ projects: [], seq: 0 })
  })
})
