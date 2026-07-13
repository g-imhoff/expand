// S3 — real cold-command latency: because of I-4 (zero-connection shutdown), a
// cold CLI command spawns the backend, so this wall time is user-facing latency.
// Pattern mirrors apps/server/test/integration/durability-restart.test.ts.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { Duration, Effect, Fiber, Option, Schedule, Layer } from "effect"
import type { Scope } from "effect"
import { NodeServices } from "@effect/platform-node"
import { runServer } from "@expand/server/composition/app"
import { withClient } from "@expand/client-ts"
import type { ExpandRpcClientApi } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { readEndpoint } from "@expand/client-ts"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { deleteCheckpoint, plantCheckpoint } from "../seed"
import { withRss } from "../rss"
import type { Measurement, ScenarioContext } from "../report"

export interface E2eRun<A> {
  readonly wallMs: number
  readonly result: A
}

const nodeAdapter = makeNodeAdapter({
  backendCommand: [process.execPath, "--import", "tsx", join(process.cwd(), "apps/server/main.ts")]
})

// Boot a real server on dbPath, run `use` over a connected client, then let the
// client disconnect and await genuine I-4 shutdown (outside the timed window).
export const withServer = <A>(
  dbPath: string,
  // `use` may require Scope: client.Events({ asQueue: true }) yields a scoped Queue.
  // withClient's internal Effect.scoped provides that scope, so this stays sound.
  use: (client: ExpandRpcClientApi) => Effect.Effect<A, unknown, Scope.Scope>
): Promise<E2eRun<A>> => {
  const dir = mkdtempSync(join(tmpdir(), "expand-bench-"))
  const awaitEndpointUp = readEndpoint.pipe(
    Effect.flatMap((o) => (Option.isSome(o) ? Effect.void : Effect.fail("pending" as const))),
    Effect.retry(Schedule.spaced("25 millis")),
    // generous: a 10m cold boot legitimately takes minutes
    Effect.timeoutOrElse({
      duration: "15 minutes",
      orElse: () => Effect.fail(new Error("server never advertised an endpoint (I-3)"))
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
      Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(new Error("no I-4 shutdown")) })
    )
    return { wallMs: Duration.toMillis(elapsed), result: out.result }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.provide(Layer.succeed(AppContext, makeBenchAppContext(dir))))
  // no cast: if the environment is not fully provided, runPromise must fail to typecheck
  return Effect.runPromise(program).finally(() => rmSync(dir, { recursive: true, force: true }))
}

export const runServerE2e = async (ctx: ScenarioContext): Promise<ReadonlyArray<Measurement>> => {
  // warm: checkpoint current — the everyday CLI case. Budget: ≤ 300ms.
  await plantCheckpoint(ctx.dbPath, 0)
  const warm = await withRss(() => withServer(ctx.dbPath, (client) => client.ProjectList({ includeArchived: true })))
  // cold: no checkpoint — worst case (informational; RSS budget still applies).
  deleteCheckpoint(ctx.dbPath)
  const cold = await withRss(() => withServer(ctx.dbPath, (client) => client.ProjectList({ includeArchived: true })))
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
  ]
}

const makeBenchAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
