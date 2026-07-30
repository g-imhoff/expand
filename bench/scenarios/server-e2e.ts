// S3 — real cold-command latency: because of I-4 (zero-connection shutdown), a
// cold CLI command spawns the backend, so this wall time is user-facing latency.
// Pattern mirrors apps/server/test/integration/durability-restart.test.ts.
import { Duration, Effect, Fiber, FileSystem, Layer, Option, Path, Schedule } from "effect"
import type { Scope } from "effect"
import { ProcessServices } from "@expand/server/runtime/node-process-control"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import type { ExpandRpcClientApi } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { deleteCheckpoint, plantCheckpoint } from "../seed"
import { withRss } from "../rss"
import { BenchmarkScenarioError } from "../report"
import type { Measurement, ScenarioContext } from "../report"

interface E2eRun<A> {
  readonly wallMs: number
  readonly result: A
}

// Boot a real server on dbPath, run `use` over a connected client, then let the
// client disconnect and await genuine I-4 shutdown (outside the timed window).
export const withServer = Effect.fn("Benchmark.withServer")(function*<A>(
  dbPath: string,
  // `use` may require Scope: client.Events({ asQueue: true }) yields a scoped Queue.
  // withClient's internal Effect.scoped provides that scope, so this stays sound.
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, unknown, Scope.Scope>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-bench-" })
  const nodeAdapter = makeNodeAdapter({
    backendCommand: Effect.succeed(["node", "--import", "tsx", path.resolve("apps/server/main.ts")])
  })
  const awaitEndpointUp = readEndpoint.pipe(
    Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
    Effect.retry(Schedule.spaced("25 millis")),
    // generous: a 10m cold boot legitimately takes minutes
    Effect.timeoutOrElse({
      duration: "15 minutes",
      orElse: () => Effect.fail(new BenchmarkScenarioError({
        scenario: "s3",
        detail: "server never advertised an endpoint (I-3)"
      }))
    })
  )
  const program = Effect.gen(function* () {
    const [elapsed, out] = yield* Effect.timed(
      Effect.gen(function* () {
        const serverFiber = yield* Effect.forkChild(runServer({ dbPath }))
        yield* awaitEndpointUp
        const result = yield* withClient(nodeAdapter, use)
        return { result, serverFiber }
      })
    )
    yield* Fiber.join(out.serverFiber).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new BenchmarkScenarioError({ scenario: "s3", detail: "no I-4 shutdown" }))
      })
    )
    return { wallMs: Duration.toMillis(elapsed), result: out.result }
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, makeBenchAppContext(path, dir))))
  )
  // no cast: if the environment is not fully provided, runPromise must fail to typecheck
  return yield* program
})

export const runServerE2e = Effect.fn("Benchmark.runServerE2e")(function*(ctx: ScenarioContext) {
  // warm: checkpoint current — the everyday CLI case. Budget: ≤ 300ms.
  yield* plantCheckpoint(ctx.dbPath, 0)
  const warm = yield* withRss(withServer(ctx.dbPath, (client) => client.ProjectList({ includeArchived: true })))
  // cold: no checkpoint — worst case (informational; RSS budget still applies).
  yield* deleteCheckpoint(ctx.dbPath)
  const cold = yield* withRss(withServer(ctx.dbPath, (client) => client.ProjectList({ includeArchived: true })))
  return [
    {
      key: "s3-e2e-warm",
      label: "S3 e2e command (warm checkpoint)",
      scale: ctx.scale,
      wallMs: warm.value.wallMs,
      events: null,
      rssDeltaBytes: warm.rssDeltaBytes
    },
    {
      key: "s3-e2e-cold",
      label: "S3 e2e command (no checkpoint)",
      scale: ctx.scale,
      wallMs: cold.value.wallMs,
      events: ctx.eventCount,
      rssDeltaBytes: cold.rssDeltaBytes
    }
  ] satisfies ReadonlyArray<Measurement>
})

const makeBenchAppContext = (path: Path.Path, dataDir: string) =>
  makeAppContext(
    { join: path.join, resolve: path.resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )
