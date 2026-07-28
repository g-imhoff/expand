import { cpus, arch, platform, totalmem } from "node:os"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Data, Effect, FileSystem, Layer, Path, Scope } from "effect"
import { ensureSeed, SCALES } from "./seed"
import { hasBlocker, makeReportMetadata, renderReport, toJsonReport } from "./report"
import type { Measurement, ScenarioContext } from "./report"
import { BenchmarkHost, makeBenchmarkHostLayer } from "./rss"
import { runColdBoot } from "./scenarios/cold-boot"
import { runWarmBoot } from "./scenarios/warm-boot"
import { runScanDrain } from "./scenarios/scan-drain"
import { runServerE2e } from "./scenarios/server-e2e"
import { runRpcReplay } from "./scenarios/rpc-replay"

interface CliOptions {
  readonly scales: ReadonlyArray<string>
  readonly scenarios: ReadonlySet<string>
  readonly chunkSize?: number
  readonly reseed: boolean
  readonly jsonPath?: string
}

interface Scenario {
  readonly id: string
  readonly run: (ctx: ScenarioContext) => Effect.Effect<ReadonlyArray<Measurement>, unknown, BenchmarkHost | FileSystem.FileSystem | Path.Path | Scope.Scope>
}

class BenchmarkCliError extends Data.TaggedError("BenchmarkCliError")<{
  readonly detail: string
}> {}

class BenchmarkBlocked extends Data.TaggedError("BenchmarkBlocked")<{}> {}

// layer-level first (attribution), then e2e (whole pipeline)
const SCENARIOS: ReadonlyArray<Scenario> = [
  { id: "s1", run: runColdBoot },
  { id: "s2", run: runWarmBoot },
  { id: "s4", run: runScanDrain },
  { id: "s3", run: runServerE2e },
  { id: "s5", run: runRpcReplay }
]

const parseCli = (argv: ReadonlyArray<string>): CliOptions => {
  const scales: Array<string> = []
  const scenarios = new Set<string>()
  let chunkSize: number | undefined
  let reseed = false
  let jsonPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--smoke") scales.push("smoke")
    else if (a === "--reseed") reseed = true
    else if (a === "--scale") scales.push(argv[++i] ?? bail("--scale needs a value"))
    else if (a === "--scenario") scenarios.add(argv[++i] ?? bail("--scenario needs a value"))
    else if (a === "--chunk") chunkSize = Number(argv[++i] ?? bail("--chunk needs a value"))
    else if (a === "--json") jsonPath = argv[++i] ?? bail("--json needs a path")
    else bail(`unknown flag: ${a}`)
  }
  if (chunkSize !== undefined && (!Number.isInteger(chunkSize) || chunkSize < 1)) bail("--chunk must be a positive integer")
  for (const s of scales) if (SCALES[s] === undefined) bail(`unknown scale: ${s} (known: ${Object.keys(SCALES).join(", ")})`)
  for (const s of scenarios) if (!SCENARIOS.some((d) => d.id === s)) bail(`unknown scenario: ${s} (known: s1..s5)`)
  return {
    scales: scales.length > 0 ? scales : ["100k", "1m"],
    scenarios: scenarios.size > 0 ? scenarios : new Set(SCENARIOS.map((d) => d.id)),
    ...(chunkSize !== undefined ? { chunkSize } : {}),
    reseed,
    ...(jsonPath !== undefined ? { jsonPath } : {})
  }
}

const bail = (msg: string): never => {
  throw new BenchmarkCliError({ detail: msg })
}

const main = Effect.fn("Benchmark.main")(function*() {
  const opts = yield* Effect.try({
    try: () => parseCli(process.argv.slice(2)),
    catch: (cause) => cause instanceof BenchmarkCliError
      ? cause
      : new BenchmarkCliError({ detail: String(cause) })
  }).pipe(Effect.tapError((error) => Console.error(`bench: ${error.detail}`)))
  const measurements: Array<Measurement> = []
  // Untimed setup: scales seed into separate cache files, so fan out. Deduped —
  // two concurrent seeds of the same path would race the rm + insert sequence.
  const uniqueScales = [...new Set(opts.scales)]
  yield* Console.log(`\n== seeding ${uniqueScales.join(", ")} (cache hit is instant; --reseed forces) ==`)
  const dbPaths = new Map(yield* Effect.forEach(
    uniqueScales,
    (scale) => ensureSeed(scale, { reseed: opts.reseed }).pipe(Effect.map((dbPath) => [scale, dbPath] as const)),
    { concurrency: "unbounded" }
  ))
  for (const scale of opts.scales) {
    yield* Console.log(`\n== ${scale} ==`)
    const ctx: ScenarioContext = {
      dbPath: dbPaths.get(scale)!,
      scale,
      eventCount: SCALES[scale]!,
      ...(opts.chunkSize !== undefined ? { chunkSize: opts.chunkSize } : {})
    }
    for (const scenario of SCENARIOS) {
      if (!opts.scenarios.has(scenario.id)) continue
      yield* Console.log(`-- ${scenario.id} @ ${scale}`)
      const result = yield* scenario.run(ctx).pipe(
        Effect.catchCause((cause) => Effect.succeed([{
          key: `${scenario.id}-died`,
          label: `${scenario.id} (died)`,
          scale,
          wallMs: 0,
          events: null,
          rssDeltaBytes: 0,
          error: Cause.pretty(cause)
        }]))
      )
      measurements.push(...result)
    }
  }
  const metadata = yield* makeReportMetadata
  yield* Console.log(renderReport(measurements, opts.chunkSize, metadata.machine))
  if (opts.jsonPath !== undefined) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(opts.jsonPath, toJsonReport(measurements, metadata))
    yield* Console.log(`json written: ${opts.jsonPath}`)
  }
  if (hasBlocker(measurements)) return yield* new BenchmarkBlocked()
})

const benchmarkHostLayer = makeBenchmarkHostLayer({
  rss: () => process.memoryUsage().rss,
  ...(globalThis.gc === undefined ? {} : { gc: () => globalThis.gc!() }),
  machineInfo: () => ({
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    totalMemGb: Math.round(totalmem() / 1024 / 1024 / 1024)
  })
})

NodeRuntime.runMain(main().pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(benchmarkHostLayer, NodeServices.layer))
), { disableErrorReporting: true })
