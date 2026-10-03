import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { createHmac } from "node:crypto"
import { createServer } from "node:http"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/sql/SqlClient"
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { GithubWebhookCredentialSlot } from "../../automation/github-webhook.js"
import type { GithubWebhookServices } from "../../automation/github-webhook.js"
import { githubWebhookRouteHandler } from "../../transport/http-server.js"
import {
  buildGithubClassificationProcess,
  githubTemplateReference,
  makeGithubExtension,
} from "@expand/contracts/automation/github"

const registry = new AutomationRegistry()
Effect.runSync(registry.register(makeGithubExtension().extension))

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Config = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCreds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Config))
const WithRoutines = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer).pipe(
  Layer.provideMerge(WithCreds),
)
const Live = Layer.mergeAll(WithRoutines, NodeHttpClient.layerFetch)

const scope = { ownerId: "webhook-http-owner", projectId: "webhook-http-project" }
const webhookSecretText = "http-webhook-secret"
const tokenSecretText = "http-token-secret"
const webhookSecretBytes = new TextEncoder().encode(webhookSecretText)
const tokenSecretBytes = new TextEncoder().encode(tokenSecretText)
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {
    token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" },
    [GithubWebhookCredentialSlot]: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-webhook" },
  },
}
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false },
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const sign = (secret: string, raw: Uint8Array): string =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(raw)).digest("hex")}`

const openedBody = {
  action: "opened",
  repository: { name: "hello", owner: { login: "octo" } },
  issue: { number: 42, title: "HTTP round trip", body: "Body" },
}

const startServer = (services: GithubWebhookServices) => {
  const routes = Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter
      yield* router.add("POST", "/webhooks/github", githubWebhookRouteHandler(services))
    }),
  )
  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0, host: "127.0.0.1" })),
  )
}

const post = (port: number, deliveryId: string | undefined, event: string | undefined, signature: string | undefined, raw: Uint8Array) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    let request = HttpClientRequest.post(`http://127.0.0.1:${port}/webhooks/github`).pipe(
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.bodyUint8Array(raw, "application/json"),
    )
    if (deliveryId !== undefined) request = HttpClientRequest.setHeader(request, "x-github-delivery", deliveryId)
    if (event !== undefined) request = HttpClientRequest.setHeader(request, "x-github-event", event)
    if (signature !== undefined) request = HttpClientRequest.setHeader(request, "x-hub-signature-256", signature)
    const response = yield* client.execute(request)
    const text = yield* response.text
    return { status: response.status, text }
  })

describe("github webhook http round trip", () => {
  it.live("persists a valid opened-issue delivery then deduplicates redelivery with no additional run", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Live)
      const services: GithubWebhookServices = {
        configurations: Context.get(context, ConfigurationRepository),
        credentials: Context.get(context, CredentialRepository),
        executions: Context.get(context, ExecutionRepository),
        sql: Context.get(context, SqlClient),
      }
      const routines = Context.get(context, RoutineService)
      yield* services.credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
      yield* services.credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
      const process = yield* buildGithubClassificationProcess("github", classification)
      yield* routines.create(scope, {
        routineId: "triage",
        template: githubTemplateReference,
        configuration: classification,
        integrations: [githubIntegration],
        process,
      })
      const transport = yield* Layer.build(startServer(services))
      const server = Context.get(transport, HttpServer.HttpServer)
      const address = server.address
      if (!NetAddress.isInetAddress(address)) return yield* Effect.fail("server did not bind an inet address")
      const raw = new TextEncoder().encode(encodeJson(openedBody))
      const first = yield* post(address.port, "http-1", "issues", sign(webhookSecretText, raw), raw)
      expect(first.status).toBe(200)
      const firstBody = decodeJson(first.text) as { accepted: boolean; jobIds: Array<string> }
      expect(firstBody.accepted).toBe(true)
      expect(firstBody.jobIds).toHaveLength(1)
      const runsBefore = yield* services.executions.listRuns(scope, { limit: 10 })
      expect(runsBefore.items).toHaveLength(1)
      const second = yield* post(address.port, "http-1", "issues", sign(webhookSecretText, raw), raw)
      expect(second.status).toBe(200)
      const runsAfter = yield* services.executions.listRuns(scope, { limit: 10 })
      expect(runsAfter.items).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerFetch)),
  )
  it.live("rejects invalid signatures with 401 and ignores unsupported events with 200 and no job", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(Live)
      const services: GithubWebhookServices = {
        configurations: Context.get(context, ConfigurationRepository),
        credentials: Context.get(context, CredentialRepository),
        executions: Context.get(context, ExecutionRepository),
        sql: Context.get(context, SqlClient),
      }
      const routines = Context.get(context, RoutineService)
      yield* services.credentials.putCredential(scope, "github-token", tokenSecretBytes, 0)
      yield* services.credentials.putCredential(scope, "github-webhook", webhookSecretBytes, 0)
      const process = yield* buildGithubClassificationProcess("github", classification)
      yield* routines.create(scope, {
        routineId: "triage",
        template: githubTemplateReference,
        configuration: classification,
        integrations: [githubIntegration],
        process,
      })
      const transport = yield* Layer.build(startServer(services))
      const server = Context.get(transport, HttpServer.HttpServer)
      const address = server.address
      if (!NetAddress.isInetAddress(address)) return yield* Effect.fail("server did not bind an inet address")
      const raw = new TextEncoder().encode(encodeJson(openedBody))
      const bad = yield* post(address.port, "http-bad", "issues", sign("wrong-secret", raw), raw)
      expect(bad.status).toBe(401)
      const pingRaw = new TextEncoder().encode(encodeJson({ zen: "hi" }))
      const ping = yield* post(address.port, "http-ping", "ping", sign(webhookSecretText, pingRaw), pingRaw)
      expect(ping.status).toBe(200)
      const runs = yield* services.executions.listRuns(scope, { limit: 10 })
      expect(runs.items).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerFetch)),
  )
})
