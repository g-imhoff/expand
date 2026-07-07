// First-guess budgets (spec §7) — recalibrate after the first real run.
// A budget is violated at ratio > 1; WATCH within WATCH_MULTIPLIER×, FAIL beyond.
export type Verdict = "PASS" | "WATCH" | "FAIL" | "ERROR"

export interface Budget {
  readonly maxMs?: number
  readonly minEventsPerSec?: number
}

// Boundedness proxy: if ΔRSS grows with N, whole-log materialization snuck back in.
export const RSS_BUDGET_BYTES = 200 * 1024 * 1024

export const WATCH_MULTIPLIER = 2

export const BUDGETS: Readonly<Record<string, Budget>> = {
  "s1-cold-boot": { minEventsPerSec: 50_000 },
  "s2-warm-boot-t0": { maxMs: 150 },
  "s2-warm-boot-t1k": { maxMs: 150 },
  "s2-warm-boot-t10k": {},
  "s3-e2e-warm": { maxMs: 300 },
  "s3-e2e-cold": {},
  "s4-scan-drain": { minEventsPerSec: 100_000 },
  "s5-rpc-replay": { minEventsPerSec: 20_000 }
}

export const verdictFor = (
  key: string,
  wallMs: number,
  events: number | null,
  rssDeltaBytes: number,
  error?: string,
  scale?: string
): Verdict => {
  if (error !== undefined) return "ERROR"
  const budget = BUDGETS[key] ?? {}
  const ratios: Array<number> = [rssDeltaBytes / RSS_BUDGET_BYTES]
  // Smoke policy: the spec defines --smoke as "verifying the harness itself in
  // seconds" — a harness-sanity scale, not a measurement scale. Throughput
  // floors are mathematically unmeetable over 1k events (fixed costs dominate),
  // so judging smoke on perf budgets would contradict the scale's purpose.
  // Smoke is judged on RSS boundedness and errors only; ms/throughput budgets
  // apply unchanged at 100k/1m/10m.
  if (scale !== "smoke") {
    if (budget.maxMs !== undefined) ratios.push(wallMs / budget.maxMs)
    if (budget.minEventsPerSec !== undefined && events !== null && events > 0 && wallMs > 0) {
      const eps = events / (wallMs / 1000)
      ratios.push(budget.minEventsPerSec / eps)
    }
  }
  const worst = Math.max(...ratios)
  if (worst <= 1) return "PASS"
  if (worst <= WATCH_MULTIPLIER) return "WATCH"
  return "FAIL"
}
