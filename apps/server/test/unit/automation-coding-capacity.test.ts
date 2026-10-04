import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import {
  clearCapacityAdapters,
  makeFixedCapacityAdapter,
  makeUnknownCapacityAdapter,
  registerCapacityAdapter,
  selectCodingProvider
} from "../../automation/coding-capacity.js"

const knownConfig = {
  providers: [
    { kind: "alpha", priority: 0 },
    { kind: "beta", priority: 1 }
  ],
  allowUnknownFallback: false
}

const assertNoQuotaPercentages = (details: ReadonlyArray<string>): void => {
  for (const detail of details) {
    expect(detail.includes("%")).toBe(false)
  }
}

describe("coding provider capacity selection", () => {
  it.effect("selects the highest-priority provider with known capacity and records evidence", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      registerCapacityAdapter(makeFixedCapacityAdapter("alpha", "available"))
      registerCapacityAdapter(makeFixedCapacityAdapter("beta", "available"))
      const result = yield* selectCodingProvider(knownConfig)
      expect(result.selectedKind).toBe("alpha")
      expect(result.outcome).toBe("selected-available")
      expect(result.evidence.map((probe) => probe.kind)).toEqual(["alpha", "beta"])
      expect(result.evidence.every((probe) => probe.state === "available")).toBe(true)
      assertNoQuotaPercentages(result.evidence.map((probe) => probe.detail))
    }))

  it.effect("skips exhausted providers and never selects them", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      registerCapacityAdapter(makeFixedCapacityAdapter("alpha", "exhausted"))
      registerCapacityAdapter(makeFixedCapacityAdapter("beta", "available"))
      const result = yield* selectCodingProvider(knownConfig)
      expect(result.selectedKind).toBe("beta")
      expect(result.outcome).toBe("selected-available")
      const alpha = result.evidence.find((probe) => probe.kind === "alpha")!
      expect(alpha.state).toBe("exhausted")
      assertNoQuotaPercentages(result.evidence.map((probe) => probe.detail))
    }))

  it.effect("keeps unknown explicit and only falls back to it when configured", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      registerCapacityAdapter(makeUnknownCapacityAdapter("alpha"))
      const strict = yield* selectCodingProvider(knownConfig).pipe(Effect.flip)
      expect(strict.code).toBe("no-provider")
      expect(strict.evidence?.find((probe) => probe.kind === "alpha")?.state).toBe("unknown")
      const permissive = yield* selectCodingProvider({ ...knownConfig, allowUnknownFallback: true })
      expect(permissive.selectedKind).toBe("alpha")
      expect(permissive.outcome).toBe("selected-unknown-fallback")
      const detail = permissive.evidence.find((probe) => probe.kind === "alpha")!.detail
      expect(detail).toContain("No usable capacity signal is exposed")
      assertNoQuotaPercentages(permissive.evidence.map((probe) => probe.detail))
    }))

  it.effect("treats missing adapters and capability mismatches as unavailable", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      registerCapacityAdapter(makeFixedCapacityAdapter("alpha", "exhausted"))
      const missing = yield* selectCodingProvider(knownConfig).pipe(Effect.flip)
      expect(missing.code).toBe("no-provider")
      expect(missing.evidence?.find((probe) => probe.kind === "beta")?.state).toBe("unavailable")
      registerCapacityAdapter(makeFixedCapacityAdapter("alpha", "available", undefined, ["execute"]))
      const mismatch = yield* selectCodingProvider(knownConfig, ["execute", "diff"]).pipe(Effect.flip)
      expect(mismatch.code).toBe("no-provider")
      expect(mismatch.evidence?.find((probe) => probe.kind === "alpha")?.state).toBe("unavailable")
      const states = (mismatch.evidence ?? []).map((probe) => probe.state)
      expect(states.includes("available")).toBe(false)
      expect(states.includes("exhausted")).toBe(false)
    }))

  it.effect("uses configured fallbacks after primaries and ignores unpermitted providers", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      registerCapacityAdapter(makeFixedCapacityAdapter("alpha", "exhausted"))
      registerCapacityAdapter(makeFixedCapacityAdapter("beta", "exhausted"))
      registerCapacityAdapter(makeFixedCapacityAdapter("gamma", "available"))
      registerCapacityAdapter(makeFixedCapacityAdapter("delta", "available"))
      const result = yield* selectCodingProvider({
        providers: [
          { kind: "alpha", priority: 0 },
          { kind: "beta", priority: 1 }
        ],
        allowUnknownFallback: false,
        fallbackKinds: ["gamma"]
      })
      expect(result.selectedKind).toBe("gamma")
      expect(result.outcome).toBe("selected-fallback")
      expect(result.evidence.map((probe) => probe.kind)).toEqual(["alpha", "beta", "gamma"])
    }))

  it.effect("rejects providers configured more than once and empty permission sets", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      const duplicate = yield* selectCodingProvider({
        providers: [
          { kind: "alpha", priority: 0 },
          { kind: "alpha", priority: 1 }
        ],
        allowUnknownFallback: false
      }).pipe(Effect.flip)
      expect(duplicate.code).toBe("invalid")
      const disabled = yield* selectCodingProvider({
        providers: [{ kind: "alpha", priority: 0, enabled: false }],
        allowUnknownFallback: false
      }).pipe(Effect.flip)
      expect(disabled.code).toBe("invalid")
    }))

  it.effect("fails when every permitted provider is exhausted or unavailable", () =>
    Effect.gen(function*() {
      clearCapacityAdapters()
      registerCapacityAdapter(makeFixedCapacityAdapter("alpha", "exhausted"))
      const failure = yield* selectCodingProvider(knownConfig).pipe(Effect.flip)
      expect(failure.code).toBe("no-provider")
      expect(failure.evidence?.length).toBe(2)
      expect(failure.evidence?.find((probe) => probe.kind === "alpha")?.state).toBe("exhausted")
      expect(failure.evidence?.find((probe) => probe.kind === "beta")?.state).toBe("unavailable")
      assertNoQuotaPercentages((failure.evidence ?? []).map((probe) => probe.detail))
    }))
})
