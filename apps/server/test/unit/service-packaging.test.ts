import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { describe, expect } from "vitest"
import { parse as parseYaml } from "yaml"

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

const readRepoFile = (relative: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url))
    return yield* fs.readFileString(path.join(root, relative))
  })

const layers = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

describe("service packaging", () => {
  it.effect("ships a reproducible container with persistent storage and health checks", () =>
    Effect.gen(function* () {
      const dockerfile = yield* readRepoFile("Dockerfile")
      expect(dockerfile).toContain("FROM node:24-slim")
      expect(dockerfile).toContain("VOLUME /data")
      expect(dockerfile).toContain("EXPOSE 3210")
      expect(dockerfile).toContain("USER expand")
      expect(dockerfile).toContain("STOPSIGNAL SIGTERM")
      expect(dockerfile).toContain("HEALTHCHECK")
      expect(dockerfile).toContain("dist/expand health --data-dir /data")
      expect(dockerfile).toContain("--keep-running")
      expect(dockerfile).toContain("--data-dir")
      expect(dockerfile).toContain("0.0.0.0")
      expect(dockerfile).toContain("3210")

      const composeRaw = yield* readRepoFile("compose.yaml")
      const parsed = parseYaml(composeRaw) as unknown
      const compose = Schema.decodeUnknownSync(ComposeFile)(parsed)
      const backend = compose.services["expand-backend"]
      expect(backend.restart).toBe("unless-stopped")
      expect(backend.ports.some((value) => value.includes("3210"))).toBe(true)
      expect(backend.volumes.some((value) => value.includes("/data"))).toBe(true)
      expect(backend.stop_grace_period).toBe("10s")
      expect(composeRaw).toContain("expand-data:/data")
      expect(composeRaw).toContain("healthcheck:")
      expect(composeRaw).toContain("dist/expand")
      expect(composeRaw).toContain("OPENCODE_ZEN_API_KEY")
      expect(composeRaw).toContain("127.0.0.1:3210:3210")

      const unit = yield* readRepoFile("ops/expand-backend.service")
      expect(unit).toContain("expand-server --keep-running")
      expect(unit).toContain("--data-dir")
      expect(unit).toContain("--port 3210")
      expect(unit).toContain("Restart=always")
      expect(unit).toContain("KillSignal=SIGTERM")
      expect(unit).toContain("TimeoutStopSec=10")
      expect(unit).toContain("UMask=0077")
      expect(unit).toContain("WantedBy=default.target")
    }).pipe(Effect.provide(layers))
  )

  it.effect("keeps webhook ingress and authenticated access on the stable service port", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url))
      const httpServer = yield* fs.readFileString(path.join(root, "apps/server/transport/http-server.ts"))
      expect(httpServer).toContain("SERVICE_HEALTH_PATH")
      expect(httpServer).toContain("serviceHealthBody")
      expect(httpServer).toContain("/webhooks/github")
      expect(httpServer).toContain("/webhooks/custom")
      expect(httpServer).toContain("/rpc")
      const serviceConfig = yield* fs.readFileString(path.join(root, "apps/server/runtime/service-config.ts"))
      expect(serviceConfig).toContain("/healthz")
      const composeRaw = yield* fs.readFileString(path.join(root, "compose.yaml"))
      expect(composeRaw).toContain("3210")
    }).pipe(Effect.provide(layers))
  )
})
