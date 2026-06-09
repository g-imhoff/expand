import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { Project } from "@yodea/contracts/project"
import { RendererRpcClient, type RendererRpcClientApi } from "@yodea/desktop/renderer/rpc/transport"
import { ProjectRpc, ProjectRpcLayer } from "@yodea/desktop/renderer/rpc/project-rpc"

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
    ProjectList: () => Effect.succeed([]),
    Connect: () => Effect.die("unused"),
    Events: () => Effect.die("unused"),
    ...over
  }) as unknown as RendererRpcClientApi

const project: Project = {
  id: "a", name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t"
}

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
        expect(payload).toEqual({ id: "a" })
        return Effect.succeed(project)
      }
    })
    const result = await ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.archive({ id: "a" })),
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
        return Effect.succeed([])
      }
    })
    const result = await ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.list({ includeArchived: true })),
      Effect.provide(ProjectRpcLayer),
      Effect.provideService(RendererRpcClient, client),
      Effect.runPromise
    )
    expect(result).toEqual([])
  })
})
