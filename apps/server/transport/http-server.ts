import { Effect, Layer, Option } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { NodeHttpServer } from "@effect/platform-node"
import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ExpandHandlers } from "@expand/server/rpc/handlers"
import { makeGithubWebhookHandler } from "@expand/server/automation/github-webhook"
import type { GithubWebhookServices } from "@expand/server/automation/github-webhook"
import { makeCustomWebhookHandler } from "@expand/server/automation/custom-webhook"
import type { CustomWebhookServices } from "@expand/server/automation/custom-webhook"
import type { AutomationRegistry } from "@expand/server/automation/registry"
import { encodeJson } from "@expand/server/automation/persistence-models"

export interface CustomWebhookRoute {
  readonly services: CustomWebhookServices
  readonly registry: AutomationRegistry
}

export const httpServerLayer = (port: number, token: string, webhookServices?: GithubWebhookServices, customWebhook?: CustomWebhookRoute) => {
  const node = NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" })
  const rpc = RpcServer.layer(ExpandRpcs).pipe(
    Layer.provide(ExpandHandlers),
    Layer.provide(guardedRouter(token, webhookServices, customWebhook)),
    Layer.provide(RpcSerialization.layerNdjson)
  )
  return HttpRouter.serve(rpc, { disableLogger: true, middleware: accessLogger }).pipe(
    Layer.provideMerge(node)
  )
}

export const githubWebhookRouteHandler = (webhookServices: GithubWebhookServices) =>
  Effect.gen(function* () {
    const webhook = makeGithubWebhookHandler(webhookServices)
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = request.headers as Record<string, string | undefined>
    const deliveryId = headers["x-github-delivery"] ?? ""
    const event = headers["x-github-event"] ?? ""
    const signature = headers["x-hub-signature-256"]
    const buffer = yield* request.arrayBuffer
    const raw = new Uint8Array(buffer)
    const outcome = yield* webhook.handle({ deliveryId, event, signature, raw })
    if (outcome.status === 401) {
      return HttpServerResponse.empty({ status: 401 })
    }
    if (!outcome.accepted) {
      return HttpServerResponse.text(encodeJson({ accepted: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return HttpServerResponse.text(
      encodeJson({ accepted: true, deliveryId: outcome.deliveryId, jobIds: [...outcome.jobIds], runIds: [...outcome.runIds] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })

export const customWebhookRouteHandler = (services: CustomWebhookServices, registry: AutomationRegistry) =>
  Effect.gen(function* () {
    const webhook = makeCustomWebhookHandler(services, registry)
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = request.headers as Record<string, string | undefined>
    const ownerId = headers["x-custom-owner"] ?? ""
    const projectId = headers["x-custom-project"] ?? ""
    const integrationId = headers["x-custom-integration"] ?? ""
    const deliveryId = headers["x-custom-delivery"] ?? ""
    const signature = headers["x-custom-signature"]
    const buffer = yield* request.arrayBuffer
    const raw = new Uint8Array(buffer)
    const outcome = yield* webhook.handle({ ownerId, projectId, integrationId, deliveryId, signature, raw })
    if (outcome.status === 401) return HttpServerResponse.empty({ status: 401 })
    if (outcome.status === 400) {
      return HttpServerResponse.text(encodeJson({ accepted: false, field: outcome.field, message: outcome.message }), { status: 400, headers: { "content-type": "application/json" } })
    }
    if (outcome.status === 404) {
      return HttpServerResponse.text(encodeJson({ accepted: false, message: outcome.message }), { status: 404, headers: { "content-type": "application/json" } })
    }
    if (outcome.status === 409) {
      return HttpServerResponse.text(encodeJson({ accepted: false, message: outcome.message }), { status: 409, headers: { "content-type": "application/json" } })
    }
    if (!outcome.accepted) {
      return HttpServerResponse.text(encodeJson({ accepted: false }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return HttpServerResponse.text(encodeJson({ accepted: true, deliveryId: outcome.deliveryId, jobIds: [...outcome.jobIds], runIds: [...outcome.runIds] }), { status: 200, headers: { "content-type": "application/json" } })
  })

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

const guardedRouter = (token: string, webhookServices?: GithubWebhookServices, customWebhook?: CustomWebhookRoute) =>
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
      if (webhookServices !== undefined) {
        yield* router.add("POST", "/webhooks/github", githubWebhookRouteHandler(webhookServices))
      }
      if (customWebhook !== undefined) {
        yield* router.add("POST", "/webhooks/custom", customWebhookRouteHandler(customWebhook.services, customWebhook.registry))
      }
      return protocol
    })
  )
