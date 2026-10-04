import { Data, Effect, Result, Schema } from "effect"
import {
  CapacityProbe,
  CodingCapacitySelectionConfig,
  CodingSelectionResult
} from "@expand/contracts/automation"
import type { CapacityState } from "@expand/contracts/automation"

export class CodingCapacityError extends Data.TaggedError("CodingCapacityError")<{
  readonly code: "unknown-provider" | "no-provider" | "invalid"
  readonly message: string
  readonly evidence?: ReadonlyArray<typeof CapacityProbe.Type>
}> {}

export interface CapacityAdapter {
  readonly kind: string
  readonly capabilities: ReadonlyArray<string>
  readonly probe: () => Effect.Effect<typeof CapacityProbe.Type, CodingCapacityError>
}

export const registerCapacityAdapter = (adapter: CapacityAdapter): void => {
  adapters.set(adapter.kind, adapter)
}

export const clearCapacityAdapters = (): void => {
  adapters.clear()
}

export const isCapacityAdapterRegistered = (kind: string): boolean => adapters.has(kind)

export const resetCapacityAdaptersForTests = (): void => {
  clearCapacityAdapters()
}

export const resolveCapacityAdapter = (
  kind: string,
  requested: ReadonlyArray<string>
): Effect.Effect<CapacityAdapter, CodingCapacityError> =>
  Effect.gen(function*() {
    const adapter = adapters.get(kind)
    if (adapter === undefined) {
      return yield* new CodingCapacityError({ code: "unknown-provider", message: `Provider ${kind} is not registered` })
    }
    for (const capability of requested) {
      if (!adapter.capabilities.includes(capability)) {
        return yield* new CodingCapacityError({
          code: "unknown-provider",
          message: `Provider ${kind} does not support capability ${capability}`
        })
      }
    }
    return adapter
  })

export const makeFixedCapacityAdapter = (
  kind: string,
  state: CapacityState,
  detail?: string,
  capabilities: ReadonlyArray<string> = ["execute", "worktree", "transcript", "diff"]
): CapacityAdapter => ({
  kind,
  capabilities: [...capabilities],
  probe: () =>
    Effect.gen(function*() {
      const text = detail ?? defaultDetail(kind, state)
      if (text.includes("%")) {
        return yield* new CodingCapacityError({
          code: "invalid",
          message: `Provider ${kind} reported an unusable capacity signal`
        })
      }
      return yield* Schema.decodeUnknownEffect(CapacityProbe, { onExcessProperty: "error" })({
        kind,
        state,
        detail: text
      }).pipe(
        Effect.mapError(() => new CodingCapacityError({
          code: "invalid",
          message: `Provider ${kind} reported an unusable capacity signal`
        }))
      )
    })
})

export const makeUnknownCapacityAdapter = (
  kind: string,
  capabilities: ReadonlyArray<string> = ["execute", "worktree", "transcript", "diff"]
): CapacityAdapter => makeFixedCapacityAdapter(kind, "unknown", undefined, capabilities)

export const selectCodingProvider = (
  input: unknown,
  requestedCapabilities: ReadonlyArray<string> = ["execute"]
): Effect.Effect<typeof CodingSelectionResult.Type, CodingCapacityError> =>
  Effect.gen(function*() {
    const config = yield* Schema.decodeUnknownEffect(CodingCapacitySelectionConfig, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError(() => new CodingCapacityError({
        code: "invalid",
        message: "Coding provider selection configuration is not usable"
      }))
    )
    const seen = new Set<string>()
    for (const provider of config.providers) {
      if (seen.has(provider.kind)) {
        return yield* new CodingCapacityError({
          code: "invalid",
          message: `Coding provider ${provider.kind} is configured more than once`
        })
      }
      seen.add(provider.kind)
    }
    const permitted = config.providers.filter((provider) => provider.enabled !== false)
    if (permitted.length === 0) {
      return yield* new CodingCapacityError({ code: "invalid", message: "No permitted coding providers are configured" })
    }
    const primaries = permitted
      .map((provider, index) => ({ kind: provider.kind, priority: provider.priority, index }))
      .sort((left, right) => left.priority - right.priority || left.index - right.index)
      .map((entry) => entry.kind)
    const primarySet = new Set(primaries)
    const fallbacks: Array<string> = []
    for (const kind of config.fallbackKinds ?? []) {
      if (!primarySet.has(kind) && !fallbacks.includes(kind)) fallbacks.push(kind)
    }
    const fallbackSet = new Set(fallbacks)
    const candidates = [...primaries, ...fallbacks]
    const evidence: Array<typeof CapacityProbe.Type> = []
    for (const kind of candidates) {
      evidence.push(yield* probeCandidate(kind, requestedCapabilities))
    }
    const primaryAvailable = evidence.find((probe) => !fallbackSet.has(probe.kind) && probe.state === "available")
    if (primaryAvailable !== undefined) {
      return yield* Schema.decodeUnknownEffect(CodingSelectionResult, { onExcessProperty: "error" })({
        selectedKind: primaryAvailable.kind,
        outcome: "selected-available",
        evidence: evidence.map((probe) => ({ kind: probe.kind, state: probe.state, detail: probe.detail }))
      }).pipe(
        Effect.mapError(() => new CodingCapacityError({
          code: "invalid",
          message: "Coding provider selection result is not usable",
          evidence
        }))
      )
    }
    const fallbackAvailable = evidence.find((probe) => fallbackSet.has(probe.kind) && probe.state === "available")
    if (fallbackAvailable !== undefined) {
      return yield* Schema.decodeUnknownEffect(CodingSelectionResult, { onExcessProperty: "error" })({
        selectedKind: fallbackAvailable.kind,
        outcome: "selected-fallback",
        evidence: evidence.map((probe) => ({ kind: probe.kind, state: probe.state, detail: probe.detail }))
      }).pipe(
        Effect.mapError(() => new CodingCapacityError({
          code: "invalid",
          message: "Coding provider selection result is not usable",
          evidence
        }))
      )
    }
    if (config.allowUnknownFallback) {
      const unknown = evidence.find((probe) => probe.state === "unknown")
      if (unknown !== undefined) {
        return yield* Schema.decodeUnknownEffect(CodingSelectionResult, { onExcessProperty: "error" })({
          selectedKind: unknown.kind,
          outcome: "selected-unknown-fallback",
          evidence: evidence.map((probe) => ({ kind: probe.kind, state: probe.state, detail: probe.detail }))
        }).pipe(
          Effect.mapError(() => new CodingCapacityError({
            code: "invalid",
            message: "Coding provider selection result is not usable",
            evidence
          }))
        )
      }
    }
    return yield* new CodingCapacityError({
      code: "no-provider",
      message: "No coding provider has usable capacity",
      evidence
    })
  })

export const selectionEvidenceLines = (result: typeof CodingSelectionResult.Type): Array<string> => [
  `outcome:${result.outcome}`,
  ...result.evidence.map((probe) => `${probe.kind}:${probe.state}:${probe.detail}`)
]

const adapters = new Map<string, CapacityAdapter>()

const defaultDetail = (kind: string, state: CapacityState): string => {
  if (state === "available") return `Provider ${kind} reports usable capacity`
  if (state === "exhausted") return `Provider ${kind} reports exhausted capacity`
  if (state === "unavailable") return `Provider ${kind} is not registered`
  return `No usable capacity signal is exposed for ${kind}`
}

const sanitizeProbe = (kind: string, probe: typeof CapacityProbe.Type): typeof CapacityProbe.Type => {
  if (probe.kind !== kind) {
    return { kind, state: "unavailable", detail: `Provider ${kind} reported an unusable capacity signal` }
  }
  if (probe.detail.includes("%")) {
    return { kind, state: "unknown", detail: defaultDetail(kind, "unknown") }
  }
  return { kind: probe.kind, state: probe.state, detail: probe.detail }
}

const probeCandidate = (
  kind: string,
  requested: ReadonlyArray<string>
): Effect.Effect<typeof CapacityProbe.Type, never> =>
  Effect.gen(function*() {
    const adapter = adapters.get(kind)
    if (adapter === undefined) {
      return { kind, state: "unavailable" as const, detail: `Provider ${kind} is not registered` }
    }
    for (const capability of requested) {
      if (!adapter.capabilities.includes(capability)) {
        return { kind, state: "unavailable" as const, detail: `Provider ${kind} does not support capability ${capability}` }
      }
    }
    const outcome = yield* Effect.result(adapter.probe())
    if (Result.isFailure(outcome)) {
      const detail = outcome.failure instanceof CodingCapacityError
        ? outcome.failure.message
        : `Provider ${kind} reported an unusable capacity signal`
      return { kind, state: "unavailable" as const, detail }
    }
    return sanitizeProbe(kind, outcome.success)
  })
