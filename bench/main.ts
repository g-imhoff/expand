import { writeFileSync } from "node:fs"
import { ensureSeed, SCALES } from "./seed"
import { hasBlocker, renderReport, toJsonReport } from "./report"
import type { Measurement, ScenarioContext } from "./report"
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

// layer-level first (attribution), then e2e (whole pipeline)
const SCENARIOS: ReadonlyArray<{ readonly id: string; readonly run: (ctx: ScenarioContext) => Promise<ReadonlyArray<Measurement>> }> = [
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
  console.error(`bench: ${msg}`)
  process.exit(1)
}

const main = async (): Promise<void> => {
  const opts = parseCli(process.argv.slice(2))
  const measurements: Array<Measurement> = []
  // Untimed setup: scales seed into separate cache files, so fan out. Deduped —
  // two concurrent seeds of the same path would race the rm + insert sequence.
  const uniqueScales = [...new Set(opts.scales)]
  console.log(`\n== seeding ${uniqueScales.join(", ")} (cache hit is instant; --reseed forces) ==`)
  const dbPaths = new Map(
    await Promise.all(uniqueScales.map(async (scale) => [scale, await ensureSeed(scale, { reseed: opts.reseed })] as const))
  )
  for (const scale of opts.scales) {
    console.log(`\n== ${scale} ==`)
    const ctx: ScenarioContext = {
      dbPath: dbPaths.get(scale)!,
      scale,
      eventCount: SCALES[scale]!,
      ...(opts.chunkSize !== undefined ? { chunkSize: opts.chunkSize } : {})
    }
    for (const s of SCENARIOS) {
      if (!opts.scenarios.has(s.id)) continue
      console.log(`-- ${s.id} @ ${scale}`)
      try {
        measurements.push(...(await s.run(ctx)))
      } catch (e) {
        measurements.push({
          key: `${s.id}-died`,
          label: `${s.id} (died)`,
          scale,
          wallMs: 0,
          events: null,
          rssDeltaBytes: 0,
          error: String(e)
        })
      }
    }
  }
  console.log(renderReport(measurements, opts.chunkSize))
  if (opts.jsonPath !== undefined) {
    writeFileSync(opts.jsonPath, toJsonReport(measurements))
    console.log(`json written: ${opts.jsonPath}`)
  }
  process.exit(hasBlocker(measurements) ? 1 : 0)
}

await main()
