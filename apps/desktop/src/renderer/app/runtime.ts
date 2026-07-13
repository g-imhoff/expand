import { Effect } from "effect"
import type { Cause } from "effect"
import { runProjectSync } from "@expand/contracts/project-sync"
import { makeIpcClient, type IpcTransportError, type MakeIpcClientOptions } from "@expand/electron-ipc/renderer"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"
import type { ProjectContextValue } from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectSyncSink, makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import { makeRendererPort } from "@expand/desktop/renderer/rpc/renderer-port"
import { ProjectRpc, ProjectRpcLayer } from "@expand/desktop/renderer/rpc/project-rpc"
import { buildRendererClient, RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

export const acquireRpcPort = (options: MakeIpcClientOptions): Effect.Effect<MessagePort, IpcTransportError> =>
  makeIpcClient(ExpandIpc, options).rpcPort

export const boot = (
  mount: (value: ProjectContextValue) => void
): Effect.Effect<never, Cause.TimeoutError | IpcTransportError> =>
  Effect.gen(function* () {
    const value = yield* Effect.timeout(
      Effect.gen(function* () {
        const messagePort = yield* acquireRpcPort({ bridge: () => window.expand, win: window })
        const client = yield* buildRendererClient(makeRendererPort(messagePort))
        const rpc = yield* ProjectRpc.pipe(
          Effect.provide(ProjectRpcLayer),
          Effect.provideService(RendererRpcClient, client)
        )
        const store = makeProjectsStore()
        const sink = makeProjectSyncSink(store)
        let resolveFirstSnapshot = () => {}
        const firstSnapshot = new Promise<void>((resolve) => {
          resolveFirstSnapshot = resolve
        })
        yield* Effect.forkScoped(
          runProjectSync({
            status: rpc.status,
            list: () => rpc.list({ includeArchived: true }),
            events: rpc.events
          }, {
            status: sink.status,
            snapshot: (snapshot) => {
              sink.snapshot(snapshot)
              resolveFirstSnapshot()
            }
          })
        )
        yield* Effect.promise(() => firstSnapshot)
        return { store, rpc }
      }),
      BOOT_TIMEOUT
    )
    yield* Effect.sync(() => mount(value))
    return yield* Effect.never
  }).pipe(Effect.scoped)

const BOOT_TIMEOUT = "10 seconds"
