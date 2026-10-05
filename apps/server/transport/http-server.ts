import { Effect, Layer, Option } from "effect"
import { HttpMiddleware, HttpRouter, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { NodeHttpServer } from "@effect/platform-node"
import { timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ExpandHandlers } from "@expand/server/rpc/handlers"
import { makeGithubWebhookHandler } from "@expand/server/automation/github-webhook"
import { makePrConflictWebhookHandler } from "@expand/server/automation/pr-conflict-webhook"
import type { GithubWebhookServices } from "@expand/server/automation/github-webhook"
import { makeCustomWebhookHandler } from "@expand/server/automation/custom-webhook"
import type { CustomWebhookInput, CustomWebhookOutcome, CustomWebhookServices } from "@expand/server/automation/custom-webhook"
import type { AutomationRegistry } from "@expand/server/automation/registry"
import { encodeJson } from "@expand/server/automation/persistence-models"
import { SERVICE_HEALTH_PATH } from "@expand/server/runtime/service-config"

export interface CustomWebhookRoute {
  readonly services: CustomWebhookServices
  readonly registry: AutomationRegistry
}

export interface CustomWebhookHttpResult {
  readonly status: 200 | 400 | 401 | 404 | 409
  readonly body: string | null
}

export const serviceHealthBody = encodeJson({ status: "ok" })

export const httpServerLayer = (port: number, token: string, webhookServices?: GithubWebhookServices, customWebhook?: CustomWebhookRoute, host = "127.0.0.1") => {
  const node = NodeHttpServer.layer(createServer, { port, host })
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
    const conflictWebhook = makePrConflictWebhookHandler(webhookServices)
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = request.headers as Record<string, string | undefined>
    const deliveryId = headers["x-github-delivery"] ?? ""
    const event = headers["x-github-event"] ?? ""
    const signature = headers["x-hub-signature-256"]
    const buffer = yield* request.arrayBuffer
    const raw = new Uint8Array(buffer)
    if (event === "pull_request") {
      const conflictOutcome = yield* conflictWebhook.handle({ deliveryId, event, signature, raw })
      if (conflictOutcome.status === 401) {
        return HttpServerResponse.empty({ status: 401 })
      }
      if (!conflictOutcome.accepted) {
        return HttpServerResponse.text(encodeJson({ accepted: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return HttpServerResponse.text(
        encodeJson({ accepted: true, deliveryId: conflictOutcome.deliveryId, jobIds: [...conflictOutcome.jobIds], runIds: [...conflictOutcome.runIds] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
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

export const customWebhookRequestInput = (
  headers: Record<string, string | undefined>,
  raw: Uint8Array,
): CustomWebhookInput => ({
  ownerId: headers["x-custom-owner"] ?? "",
  projectId: headers["x-custom-project"] ?? "",
  integrationId: headers["x-custom-integration"] ?? "",
  deliveryId: headers["x-custom-delivery"] ?? "",
  signature: headers["x-custom-signature"],
  raw,
})

export const customWebhookResult = (outcome: CustomWebhookOutcome): CustomWebhookHttpResult => {
  if (outcome.status === 401) return { status: 401, body: null }
  if (outcome.status === 400) {
    return { status: 400, body: encodeJson({ accepted: false, field: outcome.field, message: outcome.message }) }
  }
  if (outcome.status === 404) {
    return { status: 404, body: encodeJson({ accepted: false, message: outcome.message }) }
  }
  if (outcome.status === 409) {
    return { status: 409, body: encodeJson({ accepted: false, message: outcome.message }) }
  }
  if (!outcome.accepted) {
    return { status: 200, body: encodeJson({ accepted: false }) }
  }
  return { status: 200, body: encodeJson({ accepted: true, deliveryId: outcome.deliveryId, jobIds: [...outcome.jobIds], runIds: [...outcome.runIds] }) }
}

export const customWebhookRouteHandler = (services: CustomWebhookServices, registry: AutomationRegistry) =>
  Effect.gen(function* () {
    const webhook = makeCustomWebhookHandler(services, registry)
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = request.headers as Record<string, string | undefined>
    const buffer = yield* request.arrayBuffer
    const outcome = yield* webhook.handle(customWebhookRequestInput(headers, new Uint8Array(buffer)))
    const result = customWebhookResult(outcome)
    if (result.body === null) return HttpServerResponse.empty({ status: result.status })
    return HttpServerResponse.text(result.body, { status: result.status, headers: { "content-type": "application/json" } })
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
        SERVICE_HEALTH_PATH,
        Effect.succeed(HttpServerResponse.text(serviceHealthBody, { status: 200, headers: { "content-type": "application/json" } }))
      )
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
