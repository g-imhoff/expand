import { Effect, Layer } from "effect"
import type { Cause } from "effect"
import { RendererRpcClientLayer } from "@expand/desktop/renderer/rpc/transport"
import { makeRendererPort, type RendererPortLike } from "@expand/desktop/renderer/rpc/renderer-port"
import { ProjectRpcLayer } from "@expand/desktop/renderer/rpc/project-rpc"
import { ServerRpc, ServerRpcLayer } from "@expand/desktop/renderer/rpc/server-rpc"
import { RendererProjectStore, RendererProjectStoreLayer } from "@expand/desktop/renderer/features/projects/data/project-store"
import { type AppHandle, makeAppHandle } from "@expand/desktop/renderer/app/app-handle"
import { makeIpcClient, type IpcTransportError, type MakeIpcClientOptions } from "@expand/electron-ipc/renderer"
import { ExpandIpc } from "@expand/desktop/shared/ipc/channels"

/** Acquire the RPC MessagePort through the typed IPC client (nonce-correlated, spec §8). */
export const acquireRpcPort = (options: MakeIpcClientOptions): Effect.Effect<MessagePort, IpcTransportError> =>
  makeIpcClient(ExpandIpc, options).rpcPort

const appLayer = (port: RendererPortLike) => {
  const facets = Layer.mergeAll(ProjectRpcLayer, ServerRpcLayer).pipe(
    Layer.provideMerge(RendererRpcClientLayer(port))
  )
  return RendererProjectStoreLayer.pipe(Layer.provideMerge(facets))
}

const BOOT_TIMEOUT = "10 seconds"

export const boot = (mount: (handle: AppHandle) => void): Effect.Effect<never, Cause.TimeoutError | IpcTransportError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.timeout(
      Effect.gen(function* () {
        const messagePort = yield* acquireRpcPort({ bridge: () => window.expand, win: window })
        const rendererPort = makeRendererPort(messagePort)
        const context = yield* Layer.build(appLayer(rendererPort))
        return yield* Effect.gen(function* () {
          const store = yield* RendererProjectStore
          const server = yield* ServerRpc
          const inner = yield* Effect.context<RendererProjectStore | ServerRpc>()
          return makeAppHandle(store, inner, () => Effect.runPromiseWith(inner)(server.health()))
        }).pipe(Effect.provideContext(context))
      }),
      BOOT_TIMEOUT
    )
    mount(handle)
    return yield* Effect.never
  }).pipe(Effect.scoped)
