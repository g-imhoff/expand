import { Cause, Context, Deferred, Effect, Exit, Layer, PubSub, Queue, Schedule, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import { Project } from "@expand/contracts/project"
import type { ProjectCreateResult, ProjectDeleteResult } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectInvalidInput, ProjectNameConflict, ProjectNotFound } from "@expand/contracts/rpc"
import type { RuntimeAdapter } from "@expand/client-core/adapter"
import { BackendUnavailable } from "@expand/client-core/discovery"
import { acquireClient, type ExpandRpcClientApi } from "@expand/client-core/rpc-client"
import { supervised } from "@expand/client-core/supervise"

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected"

// Mutations take raw strings and forward them to the backend, which validates
// at its ingestion boundary (invalid input returns ProjectInvalidInput). The
// store never brands or validates — it only mirrors the server's event stream.
export interface ProjectStoreShape {
  readonly projects: SubscriptionRef.SubscriptionRef<ReadonlyArray<Project>>
  readonly status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
  readonly snapshot: Effect.Effect<{ readonly projects: ReadonlyArray<Project>; readonly seq: number }>
  readonly createProject: (
    name: string,
    directory?: string | null
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectDirectoryInvalid | ProjectDirectoryConflict | ProjectInvalidInput>
  readonly renameProject: (
    id: string,
    name: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectNameConflict | ProjectInvalidInput>
  readonly changeDirectory: (
    id: string,
    directory: string
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectDirectoryInvalid | ProjectDirectoryConflict>
  readonly archiveProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly restoreProject: (id: string) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound>
  readonly setMetadata: (
    id: string,
    patch: { description?: string | null; tags?: ReadonlyArray<string> }
  ) => Effect.Effect<Project, RpcClientError.RpcClientError | ProjectNotFound | ProjectInvalidInput>
  readonly deleteProject: (id: string) => Effect.Effect<ProjectDeleteResult, RpcClientError.RpcClientError | ProjectNotFound>
  readonly events: Stream.Stream<SequencedEvent>
}

export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreShape>()(
  "expand/ProjectStore"
) {}

const reconnectPolicy = Schedule.exponential("500 millis", 1.5).pipe(
  Schedule.either(Schedule.spaced("5 seconds"))
)

const withConnectionHooks = (
  adapter: RuntimeAdapter,
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
): RuntimeAdapter => ({
  ...adapter,
  protocolLayer: (url: string) =>
    adapter.protocolLayer(url).pipe(
      Layer.provide(
        Layer.succeed(RpcClient.ConnectionHooks, {
          onConnect: Effect.void,
          onDisconnect: SubscriptionRef.set(status, "reconnecting")
        })
      )
    )
})

const toUnavailable = (e: { readonly _tag: string }): BackendUnavailable =>
  e._tag === "BackendUnavailable"
    ? (e as BackendUnavailable)
    : new BackendUnavailable({ reason: String(e) })

const makeStore = (adapter: RuntimeAdapter): Effect.Effect<
  ProjectStoreShape,
  BackendUnavailable,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    // Single source of truth: projects and seq are written/read together, so a
    // snapshot can never observe a seq ahead of the projects it returns (C2).
    const state = yield* SubscriptionRef.make<{ projects: ReadonlyArray<Project>; seq: number }>({ projects: [], seq: 0 })
    // Public, read-only mirror of state.projects (the shape consumers depend on).
    const projects = yield* SubscriptionRef.make<ReadonlyArray<Project>>([])
    const status = yield* SubscriptionRef.make<ConnectionStatus>("disconnected")
    const hub = yield* PubSub.unbounded<SequencedEvent>()
    const clientRef = yield* SubscriptionRef.make<ExpandRpcClientApi | null>(null)
    const ready = yield* Deferred.make<void, BackendUnavailable>()
    const hooked = withConnectionHooks(adapter, status)

    // Keep the public mirror in sync as a strict downstream projection of `state`.
    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.changes(Stream.map(SubscriptionRef.changes(state), (s) => s.projects)),
        (ps) => SubscriptionRef.set(projects, ps)
      )
    )

    const session = Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* acquireClient(hooked)
        yield* SubscriptionRef.set(clientRef, client)
        const queue = yield* client.Events({}, { asQueue: true })
        const snapshot = yield* client.ProjectList({ includeArchived: true })
        yield* SubscriptionRef.update(state, (s) => ({
          projects: snapshot.projects,
          seq: Math.max(s.seq, snapshot.seq)
        }))
        // One-time explicit seed of the public mirror before signalling ready, so
        // consumers never observe the empty initial value.
        yield* SubscriptionRef.set(projects, snapshot.projects)
        yield* SubscriptionRef.set(status, "connected")
        yield* Deferred.succeed(ready, undefined)
        return yield* Queue.take(queue).pipe(
          Effect.flatMap((sequenced) =>
            // Gate + fold + seq-bump in ONE atomic update; publish only if newly applied.
            SubscriptionRef.modify(state, (s) =>
              sequenced.seq <= s.seq
                ? [false, s] as const
                : [true, { projects: Project.foldList(s.projects, sequenced.event), seq: sequenced.seq }] as const
            ).pipe(
              Effect.flatMap((applied) => applied ? PubSub.publish(hub, sequenced) : Effect.void)
            )
          ),
          Effect.forever
        )
      })
    )

    const connectionLoop = session.pipe(
      Effect.tapError((e) => Deferred.fail(ready, toUnavailable(e))),
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.failCause(exit.cause)
          : SubscriptionRef.set(status, "reconnecting").pipe(
              Effect.andThen(Effect.fail(new BackendUnavailable({ reason: "connection lost" })))
            )
      ),
      Effect.retry(reconnectPolicy)
    )

    yield* Effect.forkScoped(supervised("project-store-connection", connectionLoop))
    yield* Deferred.await(ready)

    const current = Effect.flatMap(SubscriptionRef.get(clientRef), (client) =>
      client === null ? Effect.die(new Error("rpc client not initialised")) : Effect.succeed(client)
    )

    return {
      projects,
      status,
      snapshot: SubscriptionRef.get(state),
      events: Stream.fromPubSub(hub),
      createProject: (name: string, directory?: string | null) =>
        current.pipe(
          Effect.flatMap((client) =>
            client.ProjectCreate({ name, ensure: true, ...(directory !== undefined ? { directory } : {}) })
          ),
          Effect.map((r: ProjectCreateResult) => r.project),
          Effect.catchTag("ProjectAlreadyExists", (e) => Effect.die(e))
        ),
      renameProject: (id: string, name: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectRename({ id, name }))),
      changeDirectory: (id: string, directory: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectChangeDirectory({ id, directory }))),
      archiveProject: (id: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectArchive({ id }))),
      restoreProject: (id: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectRestore({ id }))),
      setMetadata: (id: string, patch: { description?: string | null; tags?: ReadonlyArray<string> }) =>
        current.pipe(
          Effect.flatMap((client) =>
            client.ProjectSetMetadata({
              id,
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.tags !== undefined ? { tags: patch.tags } : {})
            })
          )
        ),
      deleteProject: (id: string) =>
        current.pipe(Effect.flatMap((client) => client.ProjectDelete({ id })))
    }
  })

export const ProjectStoreLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectStore, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(ProjectStore, makeStore(adapter))
