import { Effect, Layer, Option } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { NodeHttpServer } from "@effect/platform-node"
import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ExpandHandlers } from "@expand/server/rpc/handlers"
import { GithubWebhook, GithubWebhookLayer, GithubWebhookRoutePath } from "@expand/server/automation/github-webhook"
import type { GithubWebhookOptions } from "@expand/server/automation/github-webhook"
import { CustomWebhook, CustomWebhookLayer, CustomWebhookRoutePath } from "@expand/server/automation/custom-webhook"

export const httpServerLayer = (port: number, token: string, webhookOptions?: GithubWebhookOptions) => {
  const node = NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })
  const rpc = RpcServer.layer(ExpandRpcs).pipe(
    Layer.provide(ExpandHandlers),
    Layer.provide(guardedRpcWebsocket(token)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  const webhooks = githubWebhookRoutes().pipe(Layer.provide(GithubWebhookLayer(webhookOptions)))
  const customWebhooks = customWebhookRoutes().pipe(Layer.provide(CustomWebhookLayer))
  const app = Layer.mergeAll(rpc, webhooks, customWebhooks)
  return HttpRouter.serve(app, { disableLogger: true, middleware: accessLogger }).pipe(
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

const githubWebhookRoutes = () =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const router = yield* HttpRouter.HttpRouter
      const webhooks = yield* GithubWebhook
      yield* router.add("POST", GithubWebhookRoutePath, Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const raw = yield* request.arrayBuffer.pipe(Effect.map((buffer) => new Uint8Array(buffer)))
        const handled = yield* webhooks.handle({
          raw,
          event: request.headers["x-github-event"],
          deliveryId: request.headers["x-github-delivery"],
          signature: request.headers["x-hub-signature-256"]
        })
        return yield* HttpServerResponse.json(handled.body, { status: handled.status })
      }))
    })
  )

const customWebhookRoutes = () =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const router = yield* HttpRouter.HttpRouter
      const webhooks = yield* CustomWebhook
      yield* router.add("POST", CustomWebhookRoutePath, Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const raw = yield* request.arrayBuffer.pipe(Effect.map((buffer) => new Uint8Array(buffer)))
        const handled = yield* webhooks.handle({
          raw,
          ownerId: request.headers["x-custom-owner"],
          projectId: request.headers["x-custom-project"],
          integrationId: request.headers["x-custom-integration"],
          deliveryId: request.headers["x-custom-delivery"],
          signature: request.headers["x-custom-signature"],
          routineId: request.headers["x-custom-routine"]
        })
        return yield* HttpServerResponse.json(handled.body, { status: handled.status })
      }))
    })
  )
