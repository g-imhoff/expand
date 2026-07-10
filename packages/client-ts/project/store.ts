import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, PubSub, Queue, Schedule, Stream, SubscriptionRef } from "effect"
import { RpcClient, type RpcClientError } from "effect/unstable/rpc"
import type { FileSystem, Scope } from "effect"
import { Project } from "@expand/contracts/project"
import type { ProjectCreateResult, ProjectDeleteResult } from "@expand/contracts/project"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import type { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectInvalidInput, ProjectNameConflict, ProjectNotFound } from "@expand/contracts/rpc"
import type { RuntimeAdapter } from "../adapter"
import { BackendUnavailable } from "../errors"
import { acquireClient, type ExpandRpcClientApi } from "../rpc-client"
import { supervised } from "../supervise"

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected"

// Mutations take raw strings and forward them to the backend, which validates
// at its ingestion boundary (invalid input returns ProjectInvalidInput). The
// store never brands or validates — it only mirrors the server's event stream.
export interface ProjectStoreApi {
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
  /**
   * Framework-agnostic subscription to the reactive `projects` mirror. Invokes
   * `onProjects` with the current value immediately, then again on every
   * subsequent change, from a fiber forked into the store's own scope.
   *
   * Returns an unsubscribe function that stops delivery. The fiber is also torn
   * down automatically when the store's scope closes, so forgetting to
   * unsubscribe leaks nothing beyond the store's own lifetime.
   *
   * `onProjects` MUST NOT throw: it runs inside the delivery fiber, so a thrown
   * error kills that fiber and terminates delivery for the rest of the store's
   * lifetime. Keep the callback total (e.g. wrap risky work in try/catch).
   *
   * Prefer this over hand-rolling `Stream.runForEach(SubscriptionRef.changes(
   * store.projects), …)` + `Fiber.interrupt` inside UI effects.
   */
  readonly subscribe: (onProjects: (projects: ReadonlyArray<Project>) => void) => Effect.Effect<() => void>
}

export class ProjectStore extends Context.Service<ProjectStore, ProjectStoreApi>()(
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

/**
 * Bridge a {@link SubscriptionRef} to an imperative callback: fork a fiber (into
 * `scope`, so it dies with the store) that pushes the current value and every
 * subsequent change into `onValue`, and return a synchronous unsubscribe that
 * interrupts that fiber. Backs {@link ProjectStoreApi.subscribe}; the seam is
 * exported so it can be unit-tested against a plain ref without a live backend.
 *
 * @internal
 */
export const subscribeRef = <A>(
  ref: SubscriptionRef.SubscriptionRef<A>,
  scope: Scope.Scope,
  onValue: (value: A) => void
): Effect.Effect<() => void> =>
  Effect.map(
    Effect.forkIn(
      supervised(
        "project-store-subscription",
        Stream.runForEach(SubscriptionRef.changes(ref), (value) => Effect.sync(() => onValue(value)))
      ),
      scope
    ),
    (fiber) => () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  )

const makeStore = (adapter: RuntimeAdapter): Effect.Effect<
  ProjectStoreApi,
  BackendUnavailable,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    // The store's own scope — subscription fibers are forked into it so they are
    // interrupted when the store is torn down (see subscribe / subscribeRef).
    const scope = yield* Effect.scope
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
        current.pipe(Effect.flatMap((client) => client.ProjectDelete({ id }))),
      subscribe: (onProjects) => subscribeRef(projects, scope, onProjects)
    }
  })

export const ProjectStoreLayer = (
  adapter: RuntimeAdapter
): Layer.Layer<ProjectStore, BackendUnavailable, FileSystem.FileSystem> =>
  Layer.effect(ProjectStore, makeStore(adapter))
