import { Effect, Layer, Option } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { BunHttpServer } from "@effect/platform-bun"
import { YodeaRpcs } from "@yodea/shared/rpc"
import { YodeaHandlers } from "@yodea/server/rpc-handlers"

// Access-log middleware: a near-verbatim copy of `HttpMiddleware.logger`, with
// ONE change — a client-abort (HTTP 499) is logged at DEBUG instead of INFO.
//
// WHY: the I-4 zero-connection shutdown force-closes the transport scope while
// the presence WebSocket (`Connect`) is still attached, interrupting that
// request fiber. The stock logger renders the interrupt as
// `INFO http.span: InterruptError ... http.status: 499` — harmless (it IS the
// expected teardown), but alarming in `yodea server` output. A 499 is by
// definition a client-side abort, never a server defect, so demoting only the
// 499 case to DEBUG quiets the noise WITHOUT hiding real errors: any genuine
// failure resolves to 500/503 and still logs at INFO with its full cause.
const accessLogger = HttpMiddleware.make((httpApp) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const path = request.url
    return Effect.withLogSpan(
      Effect.flatMap(Effect.exit(httpApp), (exit) => {
        if (exit._tag === "Failure") {
          const [response, cause] = HttpServerError.causeResponseStripped(exit.cause)
          const message = Option.getOrElse(cause, () => "Sent HTTP Response")
          const annotations = {
            "http.method": request.method,
            "http.url": path,
            "http.status": response.status
          }
          // Client aborts (499) are benign teardown noise -> DEBUG; everything
          // else keeps the stock INFO-level access log.
          const log =
            response.status === 499
              ? Effect.logDebug(message)
              : Effect.log(message)
          return Effect.andThen(Effect.annotateLogs(log, annotations), exit)
        }
        return Effect.andThen(
          Effect.annotateLogs(Effect.log("Sent HTTP response"), {
            "http.method": request.method,
            "http.url": path,
            "http.status": exit.value.status
          }),
          exit
        )
      }),
      "http.span"
    )
  })
)

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
  // `disableLogger` turns off the stock access logger; `middleware` installs our
  // 499-demoting copy in its place (see `accessLogger`). Everything else about
  // `serve` is unchanged.
  return Layer.mergeAll(
    HttpRouter.serve(rpc, { disableLogger: true, middleware: accessLogger }),
    bun
  ).pipe(Layer.provide(bun))
}
