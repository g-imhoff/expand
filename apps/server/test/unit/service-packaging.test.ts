import { NodeFileSystem, NodeHttpClient, NodePath, NodeServices } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { describe, expect } from "vitest"
import { parse as parseYaml } from "yaml"
import { httpServerLayer, serviceHealthBody } from "@expand/server/transport/http-server"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@expand/server/runtime/connection-tracker"
import { DatabaseReadyLayer } from "@expand/server/migrations/sqlite"
import { ConfigurationRepositoryLayer } from "@expand/server/automation/configuration-repository"
import { CredentialRepositoryLayer } from "@expand/server/automation/credential-repository"
import { ExecutionRepositoryLayer } from "@expand/server/automation/execution-repository"
import { NotificationRepositoryLayer } from "@expand/server/automation/notification-repository"
import { RoutineServiceLayer } from "@expand/server/automation/routine-service"
import { AutomationRegistry } from "@expand/server/automation/registry"
import { AutomationRegistryService } from "@expand/server/automation/registry-service"
import { AutomationEventStoreLayer } from "@expand/server/automation/event-store"

const ComposeService = Schema.Struct({
  restart: Schema.Literal("unless-stopped"),
  ports: Schema.Array(Schema.String),
  volumes: Schema.Array(Schema.String),
  stop_grace_period: Schema.String
})
const ComposeFile = Schema.Struct({
  services: Schema.Struct({ "expand-backend": ComposeService }),
  volumes: Schema.Record(Schema.String, Schema.Unknown)
})

const HealthPayload = Schema.Struct({ status: Schema.Literal("ok") })

const readRepoFile = (relative: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url))
    return yield* fs.readFileString(path.join(root, relative))
  })

const layers = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const testCore = (dbPath: string) => {
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
  const configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(database))
  const withCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(configurations))
  const automation = ExecutionRepositoryLayer.pipe(Layer.provideMerge(withCredentials))
  const notifications = NotificationRepositoryLayer.pipe(Layer.provideMerge(database))
  const registry = new AutomationRegistry()
  const routines = RoutineServiceLayer(registry).pipe(Layer.provideMerge(withCredentials))
  const automationEvents = AutomationEventStoreLayer.pipe(Layer.provide(database))
  const registryService = Layer.succeed(AutomationRegistryService, registry)
  const http = NodeHttpClient.layerFetch
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay, automation, notifications, routines, automationEvents, registryService, http)
}

describe("service packaging", () => {
  it.effect("ships a reproducible container with persistent storage and health checks", () =>
    Effect.gen(function* () {
      const dockerfile = yield* readRepoFile("Dockerfile")
      expect(dockerfile).toContain("FROM node:24-slim")
      expect(dockerfile).toContain("VOLUME /data")
      expect(dockerfile).toContain("EXPOSE 3210")
      expect(dockerfile).toContain("USER expand")
      expect(dockerfile).toContain("STOPSIGNAL SIGTERM")
      const healthcheckLine = dockerfile.split("\n").find((line) => line.startsWith("HEALTHCHECK"))
      expect(healthcheckLine).toContain("dist/expand health")
      expect(healthcheckLine).toContain("--data-dir /data")
      expect(dockerfile).toContain("--keep-running")
      expect(dockerfile).toContain("0.0.0.0")
      expect(dockerfile).toContain("3210")

      const composeRaw = yield* readRepoFile("compose.yaml")
      const parsed = parseYaml(composeRaw) as unknown
      const compose = Schema.decodeUnknownSync(ComposeFile)(parsed)
      const backend = compose.services["expand-backend"]
      expect(backend.restart).toBe("unless-stopped")
      expect(backend.ports).toContain("127.0.0.1:3210:3210")
      expect(backend.volumes).toContain("expand-data:/data")
      expect(backend.stop_grace_period).toBe("10s")
      expect(composeRaw).toContain("127.0.0.1:3210:3210")
      expect(composeRaw).toContain("expand-data:/data")
      expect(composeRaw).toContain("healthcheck:")
      expect(composeRaw).toContain("OPENCODE_ZEN_API_KEY")
      const rawCompose = parsed as {
        services: Record<string, { healthcheck?: { test?: unknown } }>
      }
      expect(rawCompose.services["expand-backend"]?.healthcheck?.test).toEqual(
        ["CMD", "node", "dist/expand", "health", "--data-dir", "/data"]
      )

      const unit = yield* readRepoFile("ops/expand-backend.service")
      expect(unit).toContain("expand-server --keep-running")
      expect(unit).toContain("--data-dir")
      expect(unit).toContain("--host 127.0.0.1 --port 3210")
      expect(unit).toContain("Restart=always")
      expect(unit).toContain("KillSignal=SIGTERM")
      expect(unit).toContain("TimeoutStopSec=10")
      expect(unit).toContain("UMask=0077")
      expect(unit).toContain("WantedBy=default.target")
    }).pipe(Effect.provide(layers))
  )

  it.effect("registers health before authenticated routes on the stable service port", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url))
      const httpServer = yield* fs.readFileString(path.join(root, "apps/server/transport/http-server.ts"))
      const healthAt = httpServer.indexOf("SERVICE_HEALTH_PATH")
      const rpcAt = httpServer.indexOf("\"/rpc\"")
      expect(healthAt).toBeGreaterThanOrEqual(0)
      expect(rpcAt).toBeGreaterThan(healthAt)
      expect(httpServer).toContain("/webhooks/github")
      expect(httpServer).toContain("/webhooks/custom")
      expect(Schema.decodeUnknownSync(Schema.fromJsonString(HealthPayload))(serviceHealthBody)).toEqual({ status: "ok" })
      const serviceConfig = yield* fs.readFileString(path.join(root, "apps/server/runtime/service-config.ts"))
      expect(serviceConfig).toContain("/healthz")
      const composeRaw = yield* fs.readFileString(path.join(root, "compose.yaml"))
      const parsed = parseYaml(composeRaw) as { services: Record<string, { ports?: Array<string> }> }
      expect(parsed.services["expand-backend"]?.ports).toContain("127.0.0.1:3210:3210")
    }).pipe(Effect.provide(layers))
  )

  it.live("serves unauthenticated health while guarding rpc", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer))
      const path = yield* Path.Path.pipe(Effect.provide(NodeServices.layer))
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-packaging-" })
      const token = "packaging-probe-token"
      const program = Effect.gen(function* () {
        const transport = yield* Layer.build(
          Layer.mergeAll(
            httpServerLayer(0, token).pipe(Layer.provide(testCore(path.join(dir, "packaging.db")))),
            NodeServices.layer
          )
        )
        const server = yield* HttpServer.HttpServer.pipe(Effect.provide(transport))
        const client = yield* HttpClient.HttpClient
        const addr = server.address
        const port = NetAddress.isInetAddress(addr) ? addr.port : 0
        expect(port).toBeGreaterThan(0)
        const get = (url: string) =>
          Effect.gen(function* () {
            const response = yield* client.execute(HttpClientRequest.get(url))
            const text = yield* response.text
            return { status: response.status, text }
          })
        const base = `http://127.0.0.1:${port}`
        const health = yield* get(`${base}/healthz`)
        expect(health.status).toBe(200)
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(HealthPayload))(health.text)).toEqual({ status: "ok" })
        const anonymous = yield* get(`${base}/rpc`)
        expect(anonymous.status).toBe(401)
        const wrongToken = yield* get(`${base}/rpc?token=wrong`)
        expect(wrongToken.status).toBe(401)
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch)))
      yield* program
    }).pipe(Effect.scoped)
  )
})
