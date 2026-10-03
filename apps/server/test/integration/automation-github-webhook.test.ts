import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { NetAddress } from "effect/net"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeHttpClient, NodeServices } from "@effect/platform-node"
import { EventBusLayer } from "../../application/event-bus.js"
import { ProjectProjectionLayer } from "../../application/projections.js"
import { ProjectEventStoreLayer } from "../../application/projects/project-event-store.js"
import { ProjectionStateStoreLayer } from "../../db/projection-state-store.js"
import { ReplayFeedLayer } from "../../db/replay-feed.js"
import { ProjectUseCasesLayer } from "../../application/projects/use-cases.js"
import { ServerUseCasesLayer } from "../../application/server/use-cases.js"
import { ConnectionTrackerLayer } from "../../runtime/connection-tracker.js"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { signGithubDelivery } from "../../automation/github-webhook.js"
import { httpServerLayer } from "../../transport/http-server.js"
import { buildGithubClassificationProcess, githubTemplateReference } from "@expand/contracts/automation/github"
import type { IntegrationConfiguration } from "@expand/contracts/automation"

const stackFor = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const database = DatabaseReadyLayer.pipe(Layer.provideMerge(sql))
  const replay = ReplayFeedLayer.pipe(Layer.provide(database))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(database))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(database))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodeServices.layer)
  )
  const configurations = ConfigurationRepositoryLayer.pipe(Layer.provide(database))
  const automationCredentials = CredentialRepositoryLayer.pipe(Layer.provide(database))
  const executions = ExecutionRepositoryLayer.pipe(Layer.provide(Layer.mergeAll(database, configurations)))
  const core = Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay, configurations, automationCredentials, executions)
  const servers = Layer.mergeAll(httpServerLayer(0, "webhook-route-token", { allowedRepos: [{ owner: "octo", repo: "hello" }] }).pipe(Layer.provide(core)), NodeServices.layer)
  const seed = Layer.mergeAll(database, configurations, automationCredentials)
  const verify = Layer.mergeAll(database, configurations, automationCredentials, executions)
  return { servers, seed, verify }
}

const scope = { ownerId: "webhook-owner", projectId: "webhook-project" }
const webhookSecret = "webhook-route-secret-for-tests-only"
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
}
const githubIntegration: IntegrationConfiguration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {
    token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" },
    webhookSecret: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-webhook" }
  }
}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const seedEffect = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const repository = yield* ConfigurationRepository
  yield* credentials.putCredential(scope, "github-token", "route-token-for-tests-only", 0)
  yield* credentials.putCredential(scope, "github-webhook", webhookSecret, 0)
  yield* repository.putIntegration(scope, githubIntegration, 0)
  const process = yield* buildGithubClassificationProcess("github", classification)
  yield* repository.appendRoutineRevision({
    schemaVersion: 1, kind: "routine-configuration",
    reference: { routineId: "triage", revision: 1 },
    template: githubTemplateReference, scope,
    configuration: classification, integrations: [githubIntegration], process
  }, 0, "enabled")
})
const postDelivery = (client: HttpClient.HttpClient, baseUrl: string, input: { raw: Uint8Array; event: string; deliveryId: string; signature: string }) =>
  Effect.gen(function*() {
    const request = HttpClientRequest.post(`${baseUrl}/webhooks/github`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        "x-github-event": input.event,
        "x-github-delivery": input.deliveryId,
        "x-hub-signature-256": input.signature
      }),
      HttpClientRequest.bodyUint8Array(input.raw, "application/json")
    )
    const response = yield* client.execute(request)
    return { status: response.status, body: yield* response.json }
  })

describe("github webhook route", () => {
  it.live("persists opened issues over HTTP and deduplicates redeliveries", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-webhook-route-" })
    const stack = stackFor(path.join(dir, "webhook.db"))
    yield* seedEffect.pipe(Effect.provide(yield* Layer.build(stack.seed)))
    const servers = yield* Layer.build(stack.servers)
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(servers))
    const address = server.address
    const baseUrl = `http://127.0.0.1:${NetAddress.isInetAddress(address) ? address.port : 0}`
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(NodeHttpClient.layerFetch))
    const payload = { action: "opened", issue: { number: 7, title: "Boom", body: "Details" }, repository: { name: "hello", owner: { login: "octo" } } }
    const raw = new TextEncoder().encode(encode(payload as Schema.Json))
    const input = { raw, event: "issues", deliveryId: "route-delivery-1", signature: signGithubDelivery(raw, webhookSecret) }
    const accepted = yield* postDelivery(client, baseUrl, input)
    expect(accepted.status).toBe(200)
    expect(accepted.body).toEqual({
      ok: true, deliveryId: "route-delivery-1",
      jobIds: ["route-delivery-1:job:triage"], runIds: ["route-delivery-1:run:triage"]
    })
    expect(yield* postDelivery(client, baseUrl, input)).toEqual(accepted)
    const checking = yield* Layer.build(stack.verify)
    const executions = yield* ExecutionRepository.pipe(Effect.provide(checking))
    const stored = yield* executions.getDelivery(scope, "route-delivery-1")
    expect(stored?.raw).toEqual(raw)
    expect(stored?.value.payload).toEqual({ issueNumber: 7, title: "Boom", body: "Details" })
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  it.live("rejects bad signatures and ignores unsupported or unknown events over HTTP", () => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-webhook-route-" })
    const stack = stackFor(path.join(dir, "webhook.db"))
    yield* seedEffect.pipe(Effect.provide(yield* Layer.build(stack.seed)))
    const servers = yield* Layer.build(stack.servers)
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(servers))
    const address = server.address
    const baseUrl = `http://127.0.0.1:${NetAddress.isInetAddress(address) ? address.port : 0}`
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(NodeHttpClient.layerFetch))
    const payload = { action: "opened", issue: { number: 7, title: "Boom" }, repository: { name: "hello", owner: { login: "octo" } } }
    const raw = new TextEncoder().encode(encode(payload as Schema.Json))
    const forged = yield* postDelivery(client, baseUrl, { raw, event: "issues", deliveryId: "route-forged", signature: signGithubDelivery(raw, "wrong-secret") })
    expect(forged.status).toBe(401)
    const pingRaw = new TextEncoder().encode(encode({ zen: "Keep it logically awesome" } as Schema.Json))
    const ping = yield* postDelivery(client, baseUrl, { raw: pingRaw, event: "ping", deliveryId: "route-ping", signature: signGithubDelivery(pingRaw, webhookSecret) })
    expect(ping.status).toBe(200)
    expect(ping.body).toEqual({ ok: true, deliveryId: "route-ping", ignored: "unsupported-event" })
    const strangePayload = { action: "opened", issue: { number: 9, title: "Elsewhere" }, repository: { name: "other", owner: { login: "stranger" } } }
    const strangeRaw = new TextEncoder().encode(encode(strangePayload as Schema.Json))
    const strange = yield* postDelivery(client, baseUrl, { raw: strangeRaw, event: "issues", deliveryId: "route-strange", signature: signGithubDelivery(strangeRaw, webhookSecret) })
    expect(strange.status).toBe(200)
    expect(strange.body).toEqual({ ok: true, deliveryId: "route-strange", ignored: "unknown-repo" })
    const checking = yield* Layer.build(stack.verify)
    const executions = yield* ExecutionRepository.pipe(Effect.provide(checking))
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
