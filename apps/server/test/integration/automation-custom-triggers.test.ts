import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { NetAddress } from "effect/net"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeHttpClient, NodeServices } from "@effect/platform-node"
import { FileSystem, Path } from "effect"
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
import { NotificationRepositoryLayer } from "../../automation/notification-repository.js"
import { AutomationEventStoreLayer } from "../../automation/event-store.js"
import { AutomationRegistry, AutomationRegistryService } from "../../automation/registry.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationWorker, AutomationWorkerLayer } from "../../automation/worker.js"
import { signCustomDelivery } from "../../automation/custom-webhook.js"
import { httpServerLayer } from "../../transport/http-server.js"
import { automationHandlers } from "../../rpc/automation.js"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"
import type { IntegrationConfiguration } from "@expand/contracts/automation"

const scope = { ownerId: "custom-owner", projectId: "custom-project" }
const webhookSecret = "custom-route-secret-for-tests-only"
const mailIntegration: IntegrationConfiguration = {
  schemaVersion: 1, kind: "integration-configuration", id: "mail",
  definition: { id: "sample:mail", version: 1 },
  configuration: { mailbox: "inbox" },
  credentials: { webhookSecret: { schemaVersion: 1, kind: "credential-reference", credentialId: "custom-webhook" } }
}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const stackFor = (dbPath: string, registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>) => {
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
  const notifications = NotificationRepositoryLayer.pipe(Layer.provide(database))
  const routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(configurations, automationCredentials)))
  const registryService = Layer.succeed(AutomationRegistryService, registry)
  const automationEvents = AutomationEventStoreLayer.pipe(Layer.provide(database))
  const httpOutbound = NodeHttpClient.layerFetch
  const core = Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay, configurations, automationCredentials, executions, notifications, routines, registryService, automationEvents, httpOutbound)
  const servers = Layer.mergeAll(httpServerLayer(0, "custom-route-token").pipe(Layer.provide(core)), NodeServices.layer)
  const seed = Layer.mergeAll(database, configurations, automationCredentials)
  const verify = Layer.mergeAll(database, configurations, automationCredentials, executions)
  return { servers, seed, verify }
}

const seedEffect = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const repository = yield* ConfigurationRepository
  yield* credentials.putCredential(scope, "custom-webhook", webhookSecret, 0)
  yield* repository.putIntegration(scope, mailIntegration, 0)
  yield* repository.appendRoutineRevision({
    schemaVersion: 1, kind: "routine-configuration",
    reference: { routineId: "custom", revision: 1 },
    scope, configuration: { prefix: "Hello" }, integrations: [mailIntegration],
    process: {
      schemaVersion: 1, kind: "process",
      trigger: {
        definition: { id: "sample:received", version: 1 },
        integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
        configuration: {}
      },
      actions: {
        triggered: [{
          id: "send",
          action: { id: "sample:send", version: 1 },
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          bindings: {
            message: { kind: "field", source: "trigger", path: ["subject"] },
            count: { kind: "field", source: "trigger", path: ["count"] }
          }
        }]
      }
    }
  }, 0, "enabled")
})
const postCustom = (client: HttpClient.HttpClient, baseUrl: string, input: { raw: Uint8Array; deliveryId: string; signature: string; integrationId?: string }) =>
  Effect.gen(function*() {
    const request = HttpClientRequest.post(`${baseUrl}/webhooks/custom`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        "x-custom-owner": scope.ownerId,
        "x-custom-project": scope.projectId,
        "x-custom-integration": input.integrationId ?? "mail",
        "x-custom-delivery": input.deliveryId,
        "x-custom-signature": input.signature
      }),
      HttpClientRequest.bodyUint8Array(input.raw, "application/json")
    )
    const response = yield* client.execute(request)
    return { status: response.status, body: yield* response.json }
  })

describe("custom webhook route", () => {
  it.live("persists valid deliveries over HTTP and deduplicates redeliveries", () => Effect.gen(function*() {
    const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
    yield* registry.register(makeSampleExtension().extension)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-custom-route-" })
    const stack = stackFor(path.join(dir, "custom.db"), registry)
    yield* seedEffect.pipe(Effect.provide(yield* Layer.build(stack.seed)))
    const servers = yield* Layer.build(stack.servers)
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(servers))
    const address = server.address
    const baseUrl = `http://127.0.0.1:${NetAddress.isInetAddress(address) ? address.port : 0}`
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(NodeHttpClient.layerFetch))
    const raw = new TextEncoder().encode(encode({ subject: "hello", count: "3" } as Schema.Json))
    const input = { raw, deliveryId: "route-1", signature: signCustomDelivery(raw, webhookSecret) }
    const accepted = yield* postCustom(client, baseUrl, input)
    expect(accepted.status).toBe(200)
    expect(accepted.body).toEqual({
      ok: true, deliveryId: "route-1",
      jobIds: ["route-1:job:custom"], runIds: ["route-1:run:custom"]
    })
    expect(yield* postCustom(client, baseUrl, input)).toEqual(accepted)
    const checking = yield* Layer.build(stack.verify)
    const executions = yield* ExecutionRepository.pipe(Effect.provide(checking))
    const stored = yield* executions.getDelivery(scope, "route-1")
    expect(stored?.raw).toEqual(raw)
    expect(stored?.value.payload).toEqual({ subject: "hello", count: "3" })
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  it.live("rejects bad secrets with 401 and ignores unknown integrations", () => Effect.gen(function*() {
    const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
    yield* registry.register(makeSampleExtension().extension)
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-custom-route-" })
    const stack = stackFor(path.join(dir, "custom.db"), registry)
    yield* seedEffect.pipe(Effect.provide(yield* Layer.build(stack.seed)))
    const servers = yield* Layer.build(stack.servers)
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(servers))
    const address = server.address
    const baseUrl = `http://127.0.0.1:${NetAddress.isInetAddress(address) ? address.port : 0}`
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(NodeHttpClient.layerFetch))
    const raw = new TextEncoder().encode(encode({ subject: "hello", count: "3" } as Schema.Json))
    const forged = yield* postCustom(client, baseUrl, { raw, deliveryId: "route-forged", signature: signCustomDelivery(raw, "wrong-secret") })
    expect(forged.status).toBe(401)
    const unknown = yield* postCustom(client, baseUrl, { raw, deliveryId: "route-unknown", signature: signCustomDelivery(raw, webhookSecret), integrationId: "missing" })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual({ ok: true, deliveryId: "route-unknown", ignored: "unknown-integration" })
    const badPayload = new TextEncoder().encode(encode({ count: "3" } as Schema.Json))
    const invalid = yield* postCustom(client, baseUrl, { raw: badPayload, deliveryId: "route-bad", signature: signCustomDelivery(badPayload, webhookSecret) })
    expect(invalid.status).toBe(400)
    expect((invalid.body as { reason: string }).reason).toBe("invalid-payload")
    const checking = yield* Layer.build(stack.verify)
    const executions = yield* ExecutionRepository.pipe(Effect.provide(checking))
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("manual RPC through the worker path", () => {
  it.live("starts through RPC then executes with stubs and keeps previews mutation free", () => Effect.gen(function*() {
    let handlerCalls = 0
    const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
    yield* registry.register(makeSampleExtension(() => Effect.sync(() => {
      handlerCalls += 1
      return { summary: "stubbed", total: 3 }
    })).extension)
    const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
    const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
    const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
    const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
    const Routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(Configs, Creds)))
    const RegistryLive = Layer.succeed(AutomationRegistryService, registry)
    const Events = AutomationEventStoreLayer.pipe(Layer.provideMerge(Ready))
    const Feed = ReplayFeedLayer.pipe(Layer.provideMerge(Ready))
    const Worker = AutomationWorkerLayer(registry, {
      maxAttempts: 2, baseBackoffMs: 1, attemptTimeoutMs: 5000, pollBatchSize: 10, concurrency: 2, pollIntervalMs: 10, jev: {}
    }).pipe(Layer.provide(Layer.mergeAll(Execs, Configs, Creds, Routines, NodeHttpClient.layerFetch)))
    const Services = Layer.mergeAll(Ready, Configs, Creds, Execs, Routines, RegistryLive, Events, Feed, EventBusLayer, Worker, NodeHttpClient.layerFetch)
    yield* Effect.gen(function*() {
      const routines = yield* RoutineService
      const executions = yield* ExecutionRepository
      const worker = yield* AutomationWorker
      const credentials = yield* CredentialRepository
      yield* credentials.putCredential(scope, "custom-webhook", webhookSecret, 0)
      yield* routines.create(scope, {
        routineId: "custom",
        configuration: { prefix: "Hello" },
        integrations: [mailIntegration],
        process: {
          schemaVersion: 1 as const, kind: "process" as const,
          trigger: {
            definition: { id: "sample:received" as const, version: 1 as const },
            integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
            configuration: {}
          },
          actions: {
            triggered: [{
              id: "send",
              action: { id: "sample:send" as const, version: 1 as const },
              integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
              bindings: {
                message: { kind: "field" as const, source: "trigger" as const, path: ["subject"] },
                count: { kind: "field" as const, source: "trigger" as const, path: ["count"] }
              }
            }]
          }
        }
      })
      const preview = yield* automationHandlers.AutomationManualPreview({ scope, routineId: "custom", payload: { subject: "hello", count: "3" } })
      expect(preview.preview.kind).toBe("selected")
      expect((yield* executions.listRuns(scope, { limit: 100 })).items).toHaveLength(0)
      const started = yield* automationHandlers.AutomationManualStart({ scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "3" } })
      expect(started).toEqual({ deliveryId: "manual-1", jobIds: ["manual-1:job:custom"], runIds: ["manual-1:run:custom"] })
      expect(yield* automationHandlers.AutomationManualStart({ scope, routineId: "custom", deliveryId: "manual-1", payload: { subject: "hello", count: "3" } })).toEqual(started)
      yield* worker.processRun(scope, "manual-1:run:custom")
      const history = (yield* executions.history(scope, "manual-1:run:custom"))!
      expect(history.run.value.state.kind).toBe("succeeded")
      expect(handlerCalls).toBe(1)
      const previewStart = yield* automationHandlers.AutomationManualStart({ scope, routineId: "custom", deliveryId: "manual-preview", payload: { subject: "hello", count: "2" }, mode: "preview" })
      expect(previewStart.deliveryId).toBe("manual-preview")
      yield* worker.processRun(scope, "manual-preview:run:custom")
      const previewHistory = (yield* executions.history(scope, "manual-preview:run:custom"))!
      expect(previewHistory.run.value.state.kind).toBe("succeeded")
      expect(handlerCalls).toBe(1)
    }).pipe(Effect.provide(Services))
  }))
})
