import { it as effectIt } from "@effect/vitest"
import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { Readable } from "node:stream"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import type { CustomWebhookServices } from "../../automation/custom-webhook.js"
import { CustomWebhookCredentialSlot } from "@expand/contracts/automation/custom"
import { makeSampleExtension, sampleRoutine } from "../fixtures/automation-sample-extension.js"
import {
  customWebhookRequestInput,
  customWebhookResult,
  customWebhookRouteHandler,
} from "../../transport/http-server.js"

describe("custom webhook route mapping", () => {
  it("reads the caller key from headers and passes the raw body through", () => {
    const raw = new TextEncoder().encode("raw-body")
    const input = customWebhookRequestInput(
      {
        "x-custom-owner": "owner",
        "x-custom-project": "project",
        "x-custom-integration": "mail",
        "x-custom-delivery": "key-1",
        "x-custom-signature": "sha256=abc",
      },
      raw,
    )
    expect(input).toEqual({
      ownerId: "owner",
      projectId: "project",
      integrationId: "mail",
      deliveryId: "key-1",
      signature: "sha256=abc",
      raw,
    })
  })

  it("defaults missing headers to empty strings and a missing signature to undefined", () => {
    const raw = new Uint8Array()
    const input = customWebhookRequestInput({}, raw)
    expect(input.ownerId).toBe("")
    expect(input.projectId).toBe("")
    expect(input.integrationId).toBe("")
    expect(input.deliveryId).toBe("")
    expect(input.signature).toBeUndefined()
  })

  it("maps a 401 outcome to an empty body", () => {
    expect(customWebhookResult({ status: 401, accepted: false })).toEqual({ status: 401, body: null })
  })

  it("maps 400 outcomes to the failing field without extra detail", () => {
    const result = customWebhookResult({ status: 400, accepted: false, field: "payload", message: "payload is not usable" })
    expect(result.status).toBe(400)
    expect(result.body).toContain("payload")
  })

  it("maps 404 and 409 outcomes to their messages", () => {
    expect(customWebhookResult({ status: 404, accepted: false, message: "Routine does not exist" }).status).toBe(404)
    expect(customWebhookResult({ status: 409, accepted: false, message: "Delivery key was already used with different input" }).status).toBe(409)
  })

  it("maps accepted and ignored outcomes to 200 with matching accepted flags", () => {
    const accepted = customWebhookResult({ status: 200, accepted: true, deliveryId: "key-1", jobIds: ["job-1"], runIds: ["run-1"] })
    expect(accepted.status).toBe(200)
    expect(accepted.body).toContain("key-1")
    const ignored = customWebhookResult({ status: 200, accepted: false })
    expect(ignored).toEqual({ status: 200, body: '{"accepted":false}' })
  })
})

const routeRegistry = new AutomationRegistry()
Effect.runSync(routeRegistry.register(makeSampleExtension().extension))

const RouteReady = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const RouteConfig = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(RouteReady))
const RouteCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(RouteConfig))
const RouteLive = Layer.mergeAll(RoutineServiceLayer(routeRegistry), ExecutionRepositoryLayer).pipe(
  Layer.provideMerge(RouteCreds),
)

const routeScope = { ownerId: "route-owner", projectId: "route-project" }
const routeSecretText = "route-webhook-secret-value"

const routeServicesFor = Effect.gen(function* () {
  const context = yield* Layer.build(RouteLive)
  return {
    services: {
      configurations: Context.get(context, ConfigurationRepository),
      credentials: Context.get(context, CredentialRepository),
      executions: Context.get(context, ExecutionRepository),
    } satisfies CustomWebhookServices,
    routines: Context.get(context, RoutineService),
  }
})

const seedRouteRoutine = (services: CustomWebhookServices, routines: RoutineService["Service"]) =>
  Effect.gen(function* () {
    yield* services.credentials.putCredential(routeScope, "webhook-secret", new TextEncoder().encode(routeSecretText), 0)
    yield* routines.create(routeScope, {
      routineId: "personal-mail",
      template: sampleRoutine.definition,
      configuration: { prefix: "Hello" },
      integrations: [
        {
          schemaVersion: 1 as const,
          kind: "integration-configuration" as const,
          id: "mail",
          definition: { id: "sample:mail", version: 1 },
          configuration: { mailbox: "inbox" },
          credentials: {
            [CustomWebhookCredentialSlot]: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "webhook-secret" },
          },
        },
      ],
      process: sampleRoutine.process,
    })
  })

const routeSign = (secret: string, raw: Uint8Array): string =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex")}`

const stubRequest = (headers: Record<string, string | undefined>, raw: Uint8Array) =>
  ({
    headers,
    source: Readable.from([raw]),
  }) as unknown as HttpServerRequest.HttpServerRequest

const readRouteBody = (response: HttpServerResponse.HttpServerResponse): string | null => {
  if (response.body._tag === "Empty") return null
  if (response.body._tag === "Uint8Array") return response.body.text ?? new TextDecoder().decode(response.body.body)
  throw new Error(`unexpected body kind ${response.body._tag}`)
}

const routeEncode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const routeDecode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const routeRawOf = (value: unknown): Uint8Array => new TextEncoder().encode(routeEncode(value))

describe("custom webhook route handler", () => {
  effectIt.live("accepts a signed delivery with a 200 JSON body", () =>
    routeServicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRouteRoutine(services, routines)
          const raw = routeRawOf({ routineId: "personal-mail", payload: { subject: "hello", count: "2" } })
          const response = yield* customWebhookRouteHandler(services, routeRegistry).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              stubRequest(
                {
                  "x-custom-owner": routeScope.ownerId,
                  "x-custom-project": routeScope.projectId,
                  "x-custom-integration": "mail",
                  "x-custom-delivery": "route-key-1",
                  "x-custom-signature": routeSign(routeSecretText, raw),
                },
                raw,
              ),
            ),
          )
          expect(response.status).toBe(200)
          const body = readRouteBody(response)
          expect(body).not.toBeNull()
          const parsed = routeDecode(body as string) as { accepted: boolean; deliveryId: string }
          expect(parsed.accepted).toBe(true)
          expect(parsed.deliveryId).toBe("route-key-1")
        }),
      ),
      Effect.provide(RouteLive),
    ),
  )

  effectIt.live("rejects a tampered signature with an empty 401", () =>
    routeServicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRouteRoutine(services, routines)
          const raw = routeRawOf({ routineId: "personal-mail", payload: { subject: "hello", count: "2" } })
          const response = yield* customWebhookRouteHandler(services, routeRegistry).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              stubRequest(
                {
                  "x-custom-owner": routeScope.ownerId,
                  "x-custom-project": routeScope.projectId,
                  "x-custom-integration": "mail",
                  "x-custom-delivery": "route-key-bad",
                  "x-custom-signature": routeSign("wrong-secret", raw),
                },
                raw,
              ),
            ),
          )
          expect(response.status).toBe(401)
          expect(readRouteBody(response)).toBeNull()
          const runs = yield* services.executions.listRuns(routeScope, { limit: 10 })
          expect(runs.items).toEqual([])
        }),
      ),
      Effect.provide(RouteLive),
    ),
  )

  effectIt.live("maps a missing delivery header to a 400 naming the field", () =>
    routeServicesFor.pipe(
      Effect.flatMap(({ services, routines }) =>
        Effect.gen(function* () {
          yield* seedRouteRoutine(services, routines)
          const raw = routeRawOf({ routineId: "personal-mail", payload: { subject: "hello", count: "2" } })
          const response = yield* customWebhookRouteHandler(services, routeRegistry).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              stubRequest(
                {
                  "x-custom-owner": routeScope.ownerId,
                  "x-custom-project": routeScope.projectId,
                  "x-custom-integration": "mail",
                  "x-custom-signature": routeSign(routeSecretText, raw),
                },
                raw,
              ),
            ),
          )
          expect(response.status).toBe(400)
          const body = readRouteBody(response)
          expect(body).toContain("deliveryId")
        }),
      ),
      Effect.provide(RouteLive),
    ),
  )
})
