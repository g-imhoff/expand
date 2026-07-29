// Report rendering: verdict table, machine header, JSON dump.
import { Data, DateTime, Effect, Schema } from "effect"
import { verdictFor } from "./budgets"
import type { Verdict } from "./budgets"
import { BenchmarkHost } from "./rss"
import type { MachineInfo } from "./rss"

export class BenchmarkScenarioError extends Data.TaggedError("BenchmarkScenarioError")<{
  readonly scenario: string
  readonly detail: string
}> {}

export interface Measurement {
  readonly key: string
  readonly label: string
  readonly scale: string
  readonly wallMs: number
  readonly events: number | null
  readonly rssDeltaBytes: number
  readonly error?: string
}

// Shared scenario input, built by main.ts once per scale.
export interface ScenarioContext {
  readonly dbPath: string
  readonly scale: string
  readonly eventCount: number
  readonly chunkSize?: number
}

export interface ReportMetadata {
  readonly machine: MachineInfo
  readonly generatedAt: string
}

export const eventsPerSec = (m: Measurement): number | null =>
  m.events !== null && m.events > 0 && m.wallMs > 0 ? Math.round(m.events / (m.wallMs / 1000)) : null

const verdictOf = (m: Measurement): Verdict => verdictFor(m.key, m.wallMs, m.events, m.rssDeltaBytes, m.error, m.scale)

export const hasBlocker = (measurements: ReadonlyArray<Measurement>): boolean =>
  measurements.some((m) => {
    const v = verdictOf(m)
    return v === "FAIL" || v === "ERROR"
  })

export const makeReportMetadata = Effect.gen(function*() {
  const host = yield* BenchmarkHost
  const machine = yield* host.machineInfo
  const generatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
  return { machine, generatedAt }
})

export const renderReport = (
  measurements: ReadonlyArray<Measurement>,
  chunkSize: number | undefined,
  machine: MachineInfo
): string => {
  const header =
    `event-store bench — ${machine.cpu} (${machine.cores} cores, ${machine.totalMemGb}GB) · ` +
    `node ${machine.nodeVersion} · ${machine.platform}/${machine.arch} · chunk ${chunkSize ?? 1000}`
  const cols = ["scenario", "scale", "wall ms", "events/s", "ΔRSS", "verdict"] as const
  const rows = measurements.map((m) => [
    m.label,
    m.scale,
    m.error !== undefined ? "—" : fmtMs(m.wallMs),
    fmtEps(eventsPerSec(m)),
    m.error !== undefined ? "—" : fmtBytes(m.rssDeltaBytes),
    verdictOf(m) + (m.error !== undefined ? ` (${truncate(m.error, 60)})` : "")
  ])
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)))
  const line = (cells: ReadonlyArray<string>) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ")
  const caveat =
    "note: S3/S5 run server + client in one process — ΔRSS proves pipeline boundedness, not per-side attribution (S1/S4 attribute per side).\n" +
    "budgets are first guesses (bench/budgets.ts) — recalibrate after reading a real run."
  return ["", header, "", line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map(line), "", caveat].join("\n")
}

const JsonString = Schema.fromJsonString(Schema.String)
const encodeJsonString = Schema.encodeSync(JsonString)

const prettyJson = (value: unknown, depth = 0): string => {
  if (value === null) return "null"
  if (typeof value === "string") return encodeJsonString(value)
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null"
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const indent = " ".repeat((depth + 1) * 2)
    const close = " ".repeat(depth * 2)
    return `[\n${value.map((item) => `${indent}${prettyJson(item, depth + 1)}`).join(",\n")}\n${close}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (entries.length === 0) return "{}"
    const indent = " ".repeat((depth + 1) * 2)
    const close = " ".repeat(depth * 2)
    return `{\n${entries.map(([key, entry]) => `${indent}${encodeJsonString(key)}: ${prettyJson(entry, depth + 1)}`).join(",\n")}\n${close}}`
  }
  return "null"
}

export const toJsonReport = (measurements: ReadonlyArray<Measurement>, metadata: ReportMetadata): string =>
  prettyJson({
    machine: metadata.machine,
    generatedAt: metadata.generatedAt,
    measurements: measurements.map((m) => ({ ...m, eventsPerSec: eventsPerSec(m), verdict: verdictOf(m) }))
  })

const fmtMs = (ms: number): string => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toLocaleString())
const fmtEps = (eps: number | null): string => (eps === null ? "—" : eps.toLocaleString())
const fmtBytes = (b: number): string => `${(b / 1024 / 1024).toFixed(1)}MB`
const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "…")
