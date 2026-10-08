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

export {
  registerCapacityAdapter,
  clearCapacityAdapters,
  isCapacityAdapterRegistered,
  makeFixedCapacityAdapter,
  makeUnknownCapacityAdapter,
  selectCodingProvider,
  selectionEvidenceLines
}

const registerCapacityAdapter = (adapter: CapacityAdapter): void => {
  adapters.set(adapter.kind, adapter)
}

const clearCapacityAdapters = (): void => {
  adapters.clear()
}

const isCapacityAdapterRegistered = (kind: string): boolean => adapters.has(kind)

const makeFixedCapacityAdapter = (
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
          message: `Provider ${safeKind(kind)} reported an unusable capacity signal`
        })
      }
      return yield* Schema.decodeUnknownEffect(CapacityProbe, { onExcessProperty: "error" })({
        kind,
        state,
        detail: text
      }).pipe(
        Effect.mapError(() => new CodingCapacityError({
          code: "invalid",
          message: `Provider ${safeKind(kind)} reported an unusable capacity signal`
        }))
      )
    })
})

const makeUnknownCapacityAdapter = (
  kind: string,
  capabilities: ReadonlyArray<string> = ["execute", "worktree", "transcript", "diff"]
): CapacityAdapter => makeFixedCapacityAdapter(kind, "unknown", undefined, capabilities)

const selectCodingProvider = (
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
    const disabled = new Set(config.providers.filter((provider) => provider.enabled === false).map((provider) => provider.kind))
    const fallbacks: Array<string> = []
    for (const kind of config.fallbackKinds ?? []) {
      if (!primarySet.has(kind) && !disabled.has(kind) && !fallbacks.includes(kind)) fallbacks.push(kind)
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

const selectionEvidenceLines = (result: typeof CodingSelectionResult.Type): Array<string> => [
  `outcome:${result.outcome}`,
  ...result.evidence.map((probe) => `${probe.kind}:${probe.state}:${probe.detail}`)
]

const safeKind = (kind: string): string => kind.replaceAll("%", "")
const toSafeDetail = (kind: string, detail: string): string => detail.includes("%") ? `Provider ${safeKind(kind)} reported an unusable capacity signal` : detail

const adapters = new Map<string, CapacityAdapter>()

const defaultDetail = (kind: string, state: CapacityState): string => {
  if (state === "available") return `Provider ${safeKind(kind)} reports usable capacity`
  if (state === "exhausted") return `Provider ${safeKind(kind)} reports exhausted capacity`
  if (state === "unavailable") return `Provider ${safeKind(kind)} is not registered`
  return `No usable capacity signal is exposed for ${safeKind(kind)}`
}

const sanitizeProbe = (kind: string, probe: typeof CapacityProbe.Type): typeof CapacityProbe.Type => {
  if (probe.kind !== kind) {
    return { kind, state: "unavailable", detail: `Provider ${safeKind(kind)} reported an unusable capacity signal` }
  }
  if (probe.detail.includes("%")) {
    return { kind, state: "unavailable", detail: toSafeDetail(kind, defaultDetail(kind, "unavailable")) }
  }
  return { kind: probe.kind, state: probe.state, detail: toSafeDetail(kind, probe.detail) }
}

const probeCandidate = (
  kind: string,
  requested: ReadonlyArray<string>
): Effect.Effect<typeof CapacityProbe.Type, never> =>
  Effect.gen(function*() {
    const adapter = adapters.get(kind)
    if (adapter === undefined) {
      return { kind, state: "unavailable" as const, detail: `Provider ${safeKind(kind)} is not registered` }
    }
    for (const capability of requested) {
      if (!adapter.capabilities.includes(capability)) {
        return { kind, state: "unavailable" as const, detail: `Provider ${safeKind(kind)} does not support capability ${capability.replaceAll("%", "")}` }
      }
    }
    const outcome = yield* Effect.result(adapter.probe())
    if (Result.isFailure(outcome)) {
      const rawDetail = outcome.failure instanceof CodingCapacityError
        ? outcome.failure.message
        : `Provider ${safeKind(kind)} reported an unusable capacity signal`
      return { kind, state: "unavailable" as const, detail: toSafeDetail(kind, rawDetail) }
    }
    return sanitizeProbe(kind, outcome.success)
  })
