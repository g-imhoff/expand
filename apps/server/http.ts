import { Effect, Layer, Option } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { BunHttpServer } from "@effect/platform-bun"
import { timingSafeEqual } from "node:crypto"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { YodeaHandlers } from "@yodea/server/rpc-handlers"

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

const timingSafeEqualStrings = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const guardedRpcWebsocket = (token: string) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const router = yield* HttpRouter.HttpRouter
      yield* router.add(
        "GET",
        "/rpc",
        Effect.gen(function* () {
          const params = yield* HttpServerRequest.ParsedSearchParams
          const presented = params.token
          if (typeof presented !== "string" || !timingSafeEqualStrings(presented, token)) {
            return HttpServerResponse.empty({ status: 401 })
          }
          return yield* httpEffect
        })
      )
      return protocol
    })
  )

export const httpServerLayer = (port: number, token: string) => {
  const bun = BunHttpServer.layer({ port, hostname: "127.0.0.1" })
  const rpc = RpcServer.layer(YodeaRpcs).pipe(
    Layer.provide(YodeaHandlers),
    Layer.provide(guardedRpcWebsocket(token)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  return Layer.mergeAll(
    HttpRouter.serve(rpc, { disableLogger: true, middleware: accessLogger }),
    bun
  ).pipe(Layer.provide(bun))
}
