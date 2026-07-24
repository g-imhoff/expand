import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { Project, ProjectCreateResult } from "@expand/contracts/project"
import {
  ClientSession,
  type ClientSessionApi,
  type ConnectionStatus
} from "@expand/client-ts"
import {
  ProjectClient,
  type ProjectClientApi
} from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { projectHandlers } from "@expand/desktop/main/rpc/project-handlers"

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

const project = Schema.decodeUnknownSync(Project)({
  id: uid(1),
  name: "omega",
  directory: "/srv/omega",
  description: null,
  tags: [],
  archived: false,
  createdAt: "t",
  updatedAt: "t"
})

const handlers = projectHandlers as unknown as {
  readonly ProjectCreate: (payload: {
    readonly name: string
    readonly ensure: boolean
    readonly directory?: string | null
  }) => Effect.Effect<ProjectCreateResult, unknown, ProjectClient>
  readonly ProjectRename: (payload: { readonly id: string; readonly name: string }) => Effect.Effect<Project, unknown, ProjectClient>
  readonly ProjectChangeDirectory: (payload: { readonly id: string; readonly directory: string }) => Effect.Effect<Project, unknown, ProjectClient>
  readonly ProjectArchive: (payload: { readonly id: string }) => Effect.Effect<Project, unknown, ProjectClient>
  readonly ProjectRestore: (payload: { readonly id: string }) => Effect.Effect<Project, unknown, ProjectClient>
  readonly ProjectSetMetadata: (payload: {
    readonly id: string
    readonly description?: string | null
    readonly tags?: ReadonlyArray<string>
  }) => Effect.Effect<Project, unknown, ProjectClient>
  readonly ProjectDelete: (payload: { readonly id: string }) => Effect.Effect<{ readonly id: string; readonly deleted: boolean }, unknown, ProjectClient>
  readonly ProjectList: (payload: { readonly includeArchived?: boolean }) => Effect.Effect<{ readonly projects: ReadonlyArray<Project>; readonly seq: number }, unknown, ProjectClient>
}

const makeClientLayer = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>,
  client: ProjectClientApi
) => {
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(ProjectClient, client),
    Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
  )
}

const runProjectHandlers = () =>
  Effect.gen(function* () {
      const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
      let createPayload: Parameters<ProjectClientApi["create"]>[0] | undefined
      let renamePayload: Parameters<ProjectClientApi["rename"]>[0] | undefined
      let changeDirectoryPayload: Parameters<ProjectClientApi["changeDirectory"]>[0] | undefined
      let archivePayload: Parameters<ProjectClientApi["archive"]>[0] | undefined
      let restorePayload: Parameters<ProjectClientApi["restore"]>[0] | undefined
      let metadataPayload: Parameters<ProjectClientApi["setMetadata"]>[0] | undefined
      let deletePayload: Parameters<ProjectClientApi["delete"]>[0] | undefined
      let listPayload: Parameters<ProjectClientApi["list"]>[0] | undefined
      const upstreamCreateResult = yield* Schema.decodeUnknownEffect(ProjectCreateResult)({
        created: false,
        project
      })
      const client: ProjectClientApi = {
        create: (payload) => Effect.sync(() => {
          createPayload = payload
          return upstreamCreateResult
        }),
        rename: (payload) => Effect.sync(() => {
          renamePayload = payload
          return project
        }),
        changeDirectory: (payload) => Effect.sync(() => {
          changeDirectoryPayload = payload
          return project
        }),
        archive: (payload) => Effect.sync(() => {
          archivePayload = payload
          return project
        }),
        restore: (payload) => Effect.sync(() => {
          restorePayload = payload
          return project
        }),
        setMetadata: (payload) => Effect.sync(() => {
          metadataPayload = payload
          return project
        }),
        delete: (payload) => Effect.sync(() => {
          deletePayload = payload
          return { id: payload.id, deleted: true }
        }),
        list: (payload = {}) => Effect.sync(() => {
          listPayload = payload
          return { projects: [project], seq: 29 }
        }),
        events: () => Stream.die("unused")
      }
      const layer = makeClientLayer(status, client)
      const createResult = yield* handlers.ProjectCreate({
        name: "omega",
        ensure: true,
        directory: "/srv/omega"
      }).pipe(Effect.provide(layer))
      yield* handlers.ProjectRename({ id: uid(1), name: "omega-renamed" }).pipe(Effect.provide(layer))
      yield* handlers.ProjectChangeDirectory({ id: uid(1), directory: "/srv/renamed" }).pipe(Effect.provide(layer))
      yield* handlers.ProjectArchive({ id: uid(1) }).pipe(Effect.provide(layer))
      yield* handlers.ProjectRestore({ id: uid(1) }).pipe(Effect.provide(layer))
      yield* handlers.ProjectSetMetadata({ id: uid(1), description: "hi", tags: ["x"] }).pipe(Effect.provide(layer))
      yield* handlers.ProjectDelete({ id: uid(1) }).pipe(Effect.provide(layer))
      yield* handlers.ProjectList({ includeArchived: true }).pipe(Effect.provide(layer))
      return {
        createPayload,
        renamePayload,
        changeDirectoryPayload,
        archivePayload,
        restorePayload,
        metadataPayload,
        deletePayload,
        listPayload,
        createResult,
        upstreamCreateResult
      }
    })

describe("DesktopRpcHandlers", () => {
  it.effect("ProjectList and commands delegate to ProjectClient", () => Effect.gen(function* () {
    const result = yield* runProjectHandlers()
    expect(result.createPayload).toEqual({
      name: "omega",
      ensure: true,
      directory: "/srv/omega"
    })
    expect(result.listPayload).toEqual({ includeArchived: true })
    expect(result.renamePayload).toEqual({ id: uid(1), name: "omega-renamed" })
    expect(result.changeDirectoryPayload).toEqual({ id: uid(1), directory: "/srv/renamed" })
    expect(result.archivePayload).toEqual({ id: uid(1) })
    expect(result.restorePayload).toEqual({ id: uid(1) })
    expect(result.metadataPayload).toEqual({ id: uid(1), description: "hi", tags: ["x"] })
    expect(result.deletePayload).toEqual({ id: uid(1) })
    expect(result.createResult).toBe(result.upstreamCreateResult)
  }))
})
