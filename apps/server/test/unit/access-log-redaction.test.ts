import { describe, expect, it } from "vitest"
import { Effect, Layer, Logger, References, Schedule } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { httpServerLayer } from "@yodea/server/http"
import { EventStoreLayer } from "@yodea/server/db/event-store"
import { EventBusLayer } from "@yodea/server/application/event-bus"
import { ProjectProjectionLayer } from "@yodea/server/application/projections"
import { SnapshotStoreLayer } from "@yodea/server/db/snapshot-store"
import { ProjectUseCasesLayer } from "@yodea/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@yodea/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@yodea/server/connection-tracker"

// mirrors coreLayer in composition/app.ts (not exported)
const testCore = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const store = EventStoreLayer.pipe(Layer.provide(sql))
  const snapshots = SnapshotStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(store), Layer.provide(snapshots))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(store),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(BunFileSystem.layer),
    Layer.provide(BunServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, store)
}

const probeWs = (url: string): Promise<"open" | "closed"> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      resolve("closed")
      ws.close()
    }, 2000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve("open")
      ws.close()
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      resolve("closed")
    })
  })

describe("access log redaction", () => {
  it("never writes the rpc token into http.url log annotations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodea-redact-"))
    const records: Array<Record<string, unknown>> = []
    const captureLogger = Logger.make(({ fiber }) => {
      records.push({ ...fiber.getRef(References.CurrentLogAnnotations) })
    })
    const rpcRecords = () => records.filter((r) => String(r["http.url"] ?? "").startsWith("/rpc"))

    const program = Effect.gen(function* () {
      const transport = yield* Layer.build(
        Layer.mergeAll(
          httpServerLayer(0, "trust-boundary-token").pipe(
            Layer.provide(testCore(join(dir, "redact.db")))
          ),
          BunServices.layer
        ).pipe(
          Layer.provide(Logger.layer([captureLogger])),
          Layer.provide(Layer.succeed(References.MinimumLogLevel)("Debug"))
        )
      )
      const server = yield* HttpServer.HttpServer.pipe(Effect.provide(transport))
      const addr = server.address
      const port = addr._tag === "TcpAddress" ? addr.port : 0
      const opened = yield* Effect.promise(() =>
        probeWs(`ws://127.0.0.1:${port}/rpc?token=trust-boundary-token`)
      )
      yield* Effect.suspend(() =>
        rpcRecords().length > 0 ? Effect.void : Effect.fail("pending" as const)
      ).pipe(
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("no /rpc access-log record was captured"))
        })
      )
      return opened
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer))

    try {
      const opened = await Effect.runPromise(program)
      expect(opened).toBe("open")
      expect(rpcRecords().length).toBeGreaterThan(0)
      for (const annotations of records) {
        expect(JSON.stringify(annotations)).not.toContain("token=")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
