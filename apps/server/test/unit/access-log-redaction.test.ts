import { describe, expect, it } from "vitest"
import { Effect, Layer, Logger, References, Schedule } from "effect"
import { HttpServer } from "effect/unstable/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { httpServerLayer } from "@expand/server/http"
import { ReplayFeedLayer } from "@expand/server/db/replay-feed"
import { EventBusLayer } from "@expand/server/application/event-bus"
import { ProjectProjectionLayer } from "@expand/server/application/projections"
import { ProjectEventStoreLayer } from "@expand/server/application/projects/project-event-store"
import { ProjectionStateStoreLayer } from "@expand/server/db/projection-state-store"
import { ProjectUseCasesLayer } from "@expand/server/application/projects/use-cases"
import { ServerUseCasesLayer } from "@expand/server/application/server/use-cases"
import { ConnectionTrackerLayer } from "@expand/server/connection-tracker"

// mirrors coreLayer in composition/app.ts (not exported)
const testCore = (dbPath: string) => {
  const sql = SqliteClient.layer({ filename: dbPath })
  const replay = ReplayFeedLayer.pipe(Layer.provide(sql))
  const projectEvents = ProjectEventStoreLayer.pipe(Layer.provide(sql))
  const states = ProjectionStateStoreLayer.pipe(Layer.provide(sql))
  const projection = ProjectProjectionLayer.pipe(Layer.provide(projectEvents), Layer.provide(states))
  const projectUseCases = ProjectUseCasesLayer.pipe(
    Layer.provide(projectEvents),
    Layer.provide(EventBusLayer),
    Layer.provide(projection),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodeServices.layer)
  )
  return Layer.mergeAll(projectUseCases, ServerUseCasesLayer, EventBusLayer, ConnectionTrackerLayer, projection, replay)
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
    const dir = mkdtempSync(join(tmpdir(), "expand-redact-"))
    const records: Array<Record<string, unknown>> = []
    const token = "trust-boundary-token"
    const captureLogger = Logger.make(({ fiber }) => {
      records.push({ ...fiber.getRef(References.CurrentLogAnnotations) })
    })
    const rpcRecords = () => records.filter((r) => String(r["http.url"] ?? "").startsWith("/rpc"))

    const program = Effect.gen(function* () {
      const transport = yield* Layer.build(
        Layer.mergeAll(
          httpServerLayer(0, token).pipe(
            Layer.provide(testCore(join(dir, "redact.db")))
          ),
          NodeServices.layer
        ).pipe(
          Layer.provide(Logger.layer([captureLogger])),
          Layer.provide(Layer.succeed(References.MinimumLogLevel)("Debug"))
        )
      )
      const server = yield* HttpServer.HttpServer.pipe(Effect.provide(transport))
      const addr = server.address
      const port = addr._tag === "TcpAddress" ? addr.port : 0
      const opened = yield* Effect.promise(() =>
        probeWs(`ws://127.0.0.1:${port}/rpc?token=${token}`)
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
      const hostname = addr._tag === "TcpAddress" ? addr.hostname : `unexpected:${addr._tag}`
      return { hostname, opened }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

    try {
      const { hostname, opened } = await Effect.runPromise(program)
      const logOutput = JSON.stringify(records)
      expect(opened).toBe("open")
      expect(hostname).toBe("127.0.0.1")
      expect(rpcRecords().length).toBeGreaterThan(0)
      expect(logOutput).not.toContain(token)
      expect(logOutput).toContain("/rpc")
      for (const annotations of records) {
        expect(JSON.stringify(annotations)).not.toContain("token=")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
