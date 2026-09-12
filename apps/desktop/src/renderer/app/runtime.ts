import { Deferred, Effect, Fiber, Ref } from "effect"
import type { Cause, Scope } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import type { EventsLagged } from "@expand/contracts/rpc"
import { runProjectSync, type ProjectSyncSink } from "@expand/contracts/project-sync"
import { makeElectronIpcClient, type IpcTransportError } from "@expand/electron-ipc/renderer"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"
import type { ProjectContextValue } from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectSyncSink, makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import { makeRendererPort } from "@expand/desktop/renderer/rpc/renderer-port"
import { ProjectRpc, ProjectRpcLayer } from "@expand/desktop/renderer/rpc/project-rpc"
import { buildRendererClient, RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"
import { makeRendererRunner, type RendererRunner } from "@expand/desktop/renderer/app/runner"

export interface RendererBootResources {
  readonly value: ProjectContextValue
  readonly sink: ProjectSyncSink
}

export interface RendererBootDependencies {
  readonly acquireResources: () => Effect.Effect<
    RendererBootResources,
    IpcTransportError | RpcClientError.RpcClientError,
    Scope.Scope
  >
  readonly synchronize: (
    value: ProjectContextValue,
    sink: ProjectSyncSink
  ) => Effect.Effect<never, RpcClientError.RpcClientError | EventsLagged>
}

export const acquireRpcPort = Effect.fn("DesktopRenderer.acquireRpcPort")((): Effect.Effect<MessagePort, IpcTransportError> =>
  makeElectronIpcClient(ExpandIpc).rpcPort
)

export const boot = Effect.fn("DesktopRenderer.boot")(
  function* (
    mount: (value: ProjectContextValue, runner: RendererRunner) => void,
    dependencies?: RendererBootDependencies
  ): Effect.fn.Return<
    never,
    Cause.TimeoutError | IpcTransportError | RpcClientError.RpcClientError | EventsLagged,
    Scope.Scope
  > {
    const selected = dependencies ?? {
      acquireResources: Effect.fn("DesktopRenderer.acquireResources")(function* (
      ): Effect.fn.Return<RendererBootResources, IpcTransportError, Scope.Scope> {
        const messagePort = yield* acquireRpcPort()
        const client = yield* buildRendererClient(makeRendererPort(messagePort))
        const rpc = yield* ProjectRpc.pipe(
          Effect.provide(ProjectRpcLayer),
          Effect.provideService(RendererRpcClient, client)
        )
        const store = makeProjectsStore()
        return {
          value: { store, rpc },
          sink: makeProjectSyncSink(store)
        }
      }),
      synchronize: Effect.fn("DesktopRenderer.synchronize")((
        value: ProjectContextValue,
        sink: ProjectSyncSink
      ): Effect.Effect<never, RpcClientError.RpcClientError | EventsLagged> =>
        runProjectSync({
          status: value.rpc.status,
          list: () => value.rpc.list({ includeArchived: true }),
          events: value.rpc.events
        }, sink)
      )
    }
    const initialized = yield* Effect.gen(function* () {
      const resources = yield* selected.acquireResources()
      const firstSnapshot = yield* Deferred.make<void>()
      const active = yield* Ref.make(true)
      const sink: ProjectSyncSink = {
        snapshot: Effect.fn("DesktopRenderer.syncSnapshot")((snapshot) =>
          Ref.get(active).pipe(
            Effect.flatMap((isActive) =>
              isActive
                ? resources.sink.snapshot(snapshot).pipe(
                  Effect.andThen(Deferred.succeed(firstSnapshot, undefined)),
                  Effect.asVoid
                )
                : Effect.void
            )
          )),
        status: Effect.fn("DesktopRenderer.syncStatus")((status) =>
          Ref.get(active).pipe(
            Effect.flatMap((isActive) => isActive ? resources.sink.status(status) : Effect.void)
          ))
      }
      const syncFiber = yield* Effect.forkScoped(
        selected.synchronize(resources.value, sink)
      )
      yield* Effect.addFinalizer(() => Ref.set(active, false))
      yield* Effect.raceFirst(
        waitForDeferred(firstSnapshot),
        Fiber.join(syncFiber)
      )
      return { resources, syncFiber }
    }).pipe(Effect.timeout("10 seconds"))
    const owner = yield* makeRendererRunner()
    yield* Effect.sync(() => mount(initialized.resources.value, owner.runner))
    return yield* Effect.raceFirst(
      Fiber.join(initialized.syncFiber),
      owner.failure
    )
  },
  Effect.scoped
)

const waitForDeferred = Deferred["\u0061wait"]
