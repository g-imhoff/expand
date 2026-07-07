// Report rendering: verdict table, machine header, JSON dump.
import { arch, cpus, platform, totalmem } from "node:os"
import { verdictFor } from "./budgets"
import type { Verdict } from "./budgets"

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

export const eventsPerSec = (m: Measurement): number | null =>
  m.events !== null && m.events > 0 && m.wallMs > 0 ? Math.round(m.events / (m.wallMs / 1000)) : null

export const verdictOf = (m: Measurement): Verdict => verdictFor(m.key, m.wallMs, m.events, m.rssDeltaBytes, m.error)

export const hasBlocker = (measurements: ReadonlyArray<Measurement>): boolean =>
  measurements.some((m) => {
    const v = verdictOf(m)
    return v === "FAIL" || v === "ERROR"
  })

export const renderReport = (measurements: ReadonlyArray<Measurement>, chunkSize?: number): string => {
  const machine = machineInfo()
  const header =
    `event-store bench — ${machine.cpu} (${machine.cores} cores, ${machine.totalMemGb}GB) · ` +
    `bun ${machine.bunVersion} · ${machine.platform}/${machine.arch} · chunk ${chunkSize ?? 1000}`
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

export const toJsonReport = (measurements: ReadonlyArray<Measurement>): string =>
  JSON.stringify(
    {
      machine: machineInfo(),
      generatedAt: new Date().toISOString(),
      measurements: measurements.map((m) => ({ ...m, eventsPerSec: eventsPerSec(m), verdict: verdictOf(m) }))
    },
    null,
    2
  )

const machineInfo = () => ({
  cpu: cpus()[0]?.model ?? "unknown",
  cores: cpus().length,
  bunVersion: Bun.version,
  platform: platform(),
  arch: arch(),
  totalMemGb: Math.round(totalmem() / 1024 / 1024 / 1024)
})

const fmtMs = (ms: number): string => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toLocaleString())
const fmtEps = (eps: number | null): string => (eps === null ? "—" : eps.toLocaleString())
const fmtBytes = (b: number): string => `${(b / 1024 / 1024).toFixed(1)}MB`
const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1) + "…")
