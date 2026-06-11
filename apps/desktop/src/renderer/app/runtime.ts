import { Effect, Layer } from "effect"
import type { Cause } from "effect"
import { RendererRpcClientLayer } from "@yodea/desktop/renderer/rpc/transport"
import { makeRendererPort, type RendererPortLike } from "@yodea/desktop/renderer/rpc/renderer-port"
import { ProjectRpcLayer } from "@yodea/desktop/renderer/rpc/project-rpc"
import { ServerRpc, ServerRpcLayer } from "@yodea/desktop/renderer/rpc/server-rpc"
import { RendererProjectStore, RendererProjectStoreLayer } from "@yodea/desktop/renderer/features/projects/data/project-store"
import { type AppHandle, makeAppHandle } from "@yodea/desktop/renderer/app/app-handle"

export const awaitPortEffect: Effect.Effect<MessagePort> = Effect.callback<MessagePort>((resume) => {
  const onMessage = (e: MessageEvent) => {
    if (e.data === "yodea:port" && e.ports[0]) {
      window.removeEventListener("message", onMessage)
      resume(Effect.succeed(e.ports[0]))
    }
  }
  window.addEventListener("message", onMessage)
  window.yodea.requestPort()
  return Effect.sync(() => window.removeEventListener("message", onMessage))
})

const appLayer = (port: RendererPortLike) => {
  const facets = Layer.mergeAll(ProjectRpcLayer, ServerRpcLayer).pipe(
    Layer.provideMerge(RendererRpcClientLayer(port))
  )
  return RendererProjectStoreLayer.pipe(Layer.provideMerge(facets))
}

const BOOT_TIMEOUT = "10 seconds"

export const boot = (mount: (handle: AppHandle) => void): Effect.Effect<never, Cause.TimeoutError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.timeout(
      Effect.gen(function* () {
        const messagePort = yield* awaitPortEffect
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
