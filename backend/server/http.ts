import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { BunHttpServer } from "@effect/platform-bun"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { YodeaHandlers } from "@yodea/server/rpc-handlers"

// Serves YodeaRpcs over WebSocket (NDJSON) at /rpc. The handler dependencies
// (UseCases | EventBus | ConnectionTracker) bubble up as requirements for
// composition to provide.
//
// The WS protocol layer requires `HttpRouter.HttpRouter`; that requirement is
// satisfied by `HttpRouter.serve`, which provides the router into the app layer
// it receives. So the protocol (and its serialization) must be provided INTO
// the rpc app layer before it is handed to `serve` — otherwise the router
// requirement leaks out. See HttpRouter.serve's return type
// `Layer<A, ..., HttpServer | Exclude<Request.Without<R>, HttpRouter>>`
// (node_modules/effect/dist/unstable/http/HttpRouter.d.ts) which only strips
// `HttpRouter` from the app layer's own requirements.
//
// `port: 0` lets Bun pick an ephemeral OS port. We re-export the `HttpServer`
// service (merged back from `bun`) so composition can read the ACTUAL bound port
// (`server.address.port`) and advertise the real `ws://` URL. The Bun layer is
// memoized within a single build, so merging it back yields the SAME server
// instance that `serve` is running on — not a second listener.
export const httpServerLayer = (port: number) => {
  const bun = BunHttpServer.layer({ port })
  const rpc = RpcServer.layer(YodeaRpcs).pipe(
    Layer.provide(YodeaHandlers),
    Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  return Layer.mergeAll(HttpRouter.serve(rpc), bun).pipe(Layer.provide(bun))
}
