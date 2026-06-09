import { Effect, Layer } from "effect"
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

export const boot = (mount: (handle: AppHandle) => void): Effect.Effect<never> =>
  Effect.gen(function* () {
    const messagePort = yield* awaitPortEffect
    const rendererPort = makeRendererPort(messagePort) // <-- cast-free #22 fix
    const program = Effect.gen(function* () {
      const store = yield* RendererProjectStore
      const server = yield* ServerRpc
      const context = yield* Effect.context<RendererProjectStore | ServerRpc>()
      const handle = makeAppHandle(store, context, () => Effect.runPromiseWith(context)(server.health()))
      mount(handle)
      return yield* Effect.never
    })
    return yield* program.pipe(Effect.provide(appLayer(rendererPort)))
  }).pipe(Effect.scoped)
