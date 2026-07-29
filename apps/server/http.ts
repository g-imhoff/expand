import { Effect, Layer, Option } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { NodeHttpServer } from "@effect/platform-node"
import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ExpandHandlers } from "@expand/server/rpc-handlers"

export const httpServerLayer = (port: number, token: string) => {
  const node = NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })
  const rpc = RpcServer.layer(ExpandRpcs).pipe(
    Layer.provide(ExpandHandlers),
    Layer.provide(guardedRpcWebsocket(token)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  return HttpRouter.serve(rpc, { disableLogger: true, middleware: accessLogger }).pipe(
    Layer.provideMerge(node)
  )
}

const accessLogger = HttpMiddleware.make((httpApp) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const path = request.url.split("?")[0]
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
    Effect.gen(function*() {
      const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket
      const router = yield* HttpRouter.HttpRouter
      yield* router.add(
        "GET",
        "/rpc",
        Effect.gen(function*() {
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
