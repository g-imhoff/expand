import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Schema, Stream } from "effect"
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

const provideClient = (client: RendererRpcClientApi) =>
  <A, E>(effect: Effect.Effect<A, E, ProjectRpc>) => effect.pipe(
    Effect.provide(ProjectRpcLayer),
    Effect.provideService(RendererRpcClient, client)
  )

describe("ProjectRpcLayer", () => {
  it.effect("create passes the payload straight through to ProjectCreate", () => Effect.gen(function* () {
    const client = fakeClient({
      ProjectCreate: (payload) => {
        expect(payload).toEqual({ name: "alpha", ensure: true })
        return Effect.succeed({ created: true, project })
      }
    })
    const result = yield* ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.create({ name: "alpha", ensure: true })),
      provideClient(client)
    )
    expect(result).toEqual({ created: true, project })
  }))

  it.effect("archive forwards the { id } payload", () => Effect.gen(function* () {
    const client = fakeClient({
      ProjectArchive: (payload) => {
        expect(payload).toEqual({ id: uid(1) })
        return Effect.succeed(project)
      }
    })
    const result = yield* ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.archive({ id: uid(1) })),
      provideClient(client)
    )
    expect(result).toEqual(project)
  }))

  it.effect("list forwards includeArchived (defaulting to {})", () => Effect.gen(function* () {
    const client = fakeClient({
      ProjectList: (payload) => {
        expect(payload).toEqual({ includeArchived: true })
        return Effect.succeed({ projects: [], seq: 0 })
      }
    })
    const result = yield* ProjectRpc.pipe(
      Effect.flatMap((rpc) => rpc.list({ includeArchived: true })),
      provideClient(client)
    )
    expect(result).toEqual({ projects: [], seq: 0 })
  }))

  it.effect("maps Connect booleans to project sync statuses", () => Effect.gen(function* () {
    const client = fakeClient({ Connect: () => Stream.make(true, false) })
    const result = yield* ProjectRpc.pipe(
      Effect.flatMap((rpc) => Stream.runCollect(rpc.status)),
      provideClient(client)
    )
    expect(Array.from(result)).toEqual(["connected", "reconnecting"])
  }))

  it.effect("forwards Events fromSeq unchanged", () => Effect.gen(function* () {
    const client = fakeClient({
      Events: (payload) => {
        expect(payload).toEqual({ fromSeq: 17 })
        return Stream.empty
      }
    })
    yield* ProjectRpc.pipe(
      Effect.flatMap((rpc) => Stream.runDrain(rpc.events({ fromSeq: 17 }))),
      provideClient(client)
    )
  }))
})
