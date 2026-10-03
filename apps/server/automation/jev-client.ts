import { Data, Clock, Config, Duration, Effect, FileSystem, Option, Schema } from "effect"
import { HttpClient } from "effect/http"
import { CredentialReference, JevDecisionRequest, JevDecisionResult, LocalId, PersonalScope } from "@expand/contracts/automation"
import type { CredentialStatus } from "./persistence-models.js"
import { CredentialRepository } from "./credential-repository.js"
import { ZenChoiceAnswer, ZenJevModel, ZenSystemOneEndpoint, ZenSystemOneRequest, postSystemOne } from "./jev-transport.js"
import type { ZenTransportError } from "./jev-transport.js"

export class JevDecisionError extends Data.TaggedError("JevDecisionError")<{
  readonly code: "invalid-contract" | "auth" | "rate-limited" | "transient" | "timeout" | "missing-credential" | "invalid-credential"
  readonly message: string
  readonly status?: number
}> {}

export interface JevClassifyOptions {
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly questionId?: string
  readonly instructions?: string
}

export interface JevCheckInput {
  readonly apiKey?: string
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
  readonly state?: Schema.Json
  readonly outcomes?: ReadonlyArray<string>
  readonly descriptions?: Record<string, string>
}

export interface JevLiveCheck {
  readonly ok: boolean
  readonly blocked: boolean
  readonly latencyMs?: number
  readonly outcomeId?: string
  readonly confidence?: number
  readonly code?: string
  readonly reason?: string
  readonly status?: number
}

export const JevDefaultTimeoutMs = 10000
export const JevDefaultMaxRetries = 2
export const JevDefaultQuestionId = "decision"
export const JevDefaultInstructions = "Select the outcome that best matches the input."
export const JevAbstainChoice = "no_match"
export const JevUnknownChoice = "unknown"
export const ZenApiKeyEnvironments = ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"] as const
export const ZenApiKeyFileEnvironment = "EXPAND_ZEN_API_KEY_FILE"
export const ZenApiKeyFileSuffix = ".config/expand/zen-api-key"

export const JevDescriptions = Schema.Record(Schema.String, Schema.String.check(Schema.isMinLength(1)))
export type JevDescriptions = typeof JevDescriptions.Type

export const dryRunJevRequest = Effect.fn("JevClient.dryRun")(function*(request: unknown, descriptions: unknown, options?: JevClassifyOptions) {
  const settings = yield* resolveSettings(options)
  const prepared = yield* prepareDecision(request, descriptions, settings.questionId, settings.instructions)
  return prepared.body
})

export const mapZenAnswerToDecision = Effect.fn("JevClient.mapAnswer")(function*(outcomes: ReadonlyArray<string>, answer: unknown) {
  const parsed = yield* Schema.decodeUnknownEffect(ZenChoiceAnswer, { onExcessProperty: "error" })(answer).pipe(
    Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Zen answer does not match the decision contract" }))
  )
  if (parsed.choice === JevAbstainChoice || parsed.choice === JevUnknownChoice) {
    return yield* Schema.decodeUnknownEffect(JevDecisionResult, { onExcessProperty: "error" })({
      schemaVersion: 1, kind: "abstained", reason: `No candidate matched the input (${parsed.choice})`
    }).pipe(
      Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Abstention does not match the decision contract" }))
    )
  }
  if (!outcomes.includes(parsed.choice)) {
    return yield* new JevDecisionError({ code: "invalid-contract", message: "Zen selected an outcome outside the requested candidates" })
  }
  return yield* Schema.decodeUnknownEffect(JevDecisionResult, { onExcessProperty: "error" })({
    schemaVersion: 1, kind: "selected", outcomeId: parsed.choice,
    data: { choice: parsed.choice, probabilities: parsed.probabilities, confidence: parsed.confidence }
  }).pipe(
    Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Selection does not match the decision contract" }))
  )
})

export const classifyJev = Effect.fn("JevClient.classify")(function*(request: unknown, descriptions: unknown, apiKey: string, options?: JevClassifyOptions) {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return yield* new JevDecisionError({ code: "auth", message: "Missing Zen API key" })
  }
  const settings = yield* resolveSettings(options)
  const prepared = yield* prepareDecision(request, descriptions, settings.questionId, settings.instructions)
  return yield* attemptWithRetry({
    endpoint: settings.endpoint, apiKey, body: prepared.body, outcomes: prepared.outcomes,
    questionId: settings.questionId, timeoutMs: settings.timeoutMs, maxRetries: settings.maxRetries
  }, 0)
})

export const classifyJevWithCredential = Effect.fn("JevClient.classifyWithCredential")(function*(
  scope: unknown, reference: unknown, request: unknown, descriptions: unknown, options?: JevClassifyOptions
) {
  const provedScope = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Credential scope does not match the automation contract" }))
  )
  const provedReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(reference).pipe(
    Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Credential reference does not match the automation contract" }))
  )
  const repository = yield* CredentialRepository
  const secret = yield* repository.resolveSecret(provedScope, provedReference.credentialId).pipe(
    Effect.mapError((storage) => storage.code === "missing"
      ? new JevDecisionError({ code: "missing-credential", message: "Zen credential is not configured" })
      : new JevDecisionError({ code: "transient", message: "Credential resolution failed" }))
  )
  if (typeof secret !== "string" || secret.length === 0) {
    return yield* new JevDecisionError({ code: "invalid-credential", message: "Zen credential is not a usable API key" })
  }
  return yield* classifyJev(request, descriptions, secret, options)
})

export const jevCredentialStatus = Effect.fn("JevClient.credentialStatus")(function*(scope: unknown, credentialId: unknown) {
  const provedScope = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Credential scope does not match the automation contract" }))
  )
  const provedId = yield* Schema.decodeUnknownEffect(LocalId, { onExcessProperty: "error" })(credentialId).pipe(
    Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Credential ID does not match the automation contract" }))
  )
  const repository = yield* CredentialRepository
  const status: CredentialStatus | null = yield* repository.status(provedScope, provedId)
  return status
})

export const resolveZenApiKey = Effect.fn("JevClient.resolveApiKey")(function*(explicit?: string) {
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  for (const name of ZenApiKeyEnvironments) {
    const candidate = yield* Config.option(Config.String(name))
    if (Option.isSome(candidate) && candidate.value.length > 0) return candidate.value
  }
  const override = yield* Config.option(Config.String(ZenApiKeyFileEnvironment))
  const home = yield* Config.option(Config.String("HOME"))
  const path = Option.isSome(override) && override.value.length > 0
    ? override.value
    : Option.isSome(home) && home.value.length > 0 ? `${home.value}/${ZenApiKeyFileSuffix}` : null
  if (path === null) return null
  const trimmed = yield* FileSystem.FileSystem.pipe(
    Effect.flatMap((files) => files.readFileString(path)),
    Effect.map((text) => text.trim()),
    Effect.catch(() => Effect.succeed(null))
  )
  if (trimmed === null || trimmed.length === 0) return null
  return trimmed
})

export const checkJevLive = Effect.fn("JevClient.checkLive")(function*(input?: JevCheckInput) {
  const apiKey = yield* resolveZenApiKey(input?.apiKey)
  if (apiKey === null) {
    const blocked: JevLiveCheck = {
      ok: false, blocked: true, reason: "Missing Zen API key: set OPENCODE_ZEN_API_KEY or provide the key file"
    }
    return blocked
  }
  const request = {
    schemaVersion: 1 as const, kind: "jev-request" as const,
    provider: "opencode-zen" as const, model: "jev" as const, version: "1.13" as const,
    configuration: { routineId: "live-check", revision: 1 },
    input: { kind: "input-reference" as const, id: "live-check" },
    outcomes: input?.outcomes ?? ["billing", "technical"],
    data: input?.state ?? "My payouts have been failing for three days and I am losing sales."
  }
  const descriptions = input?.descriptions ?? {
    billing: "Payments, invoicing, or refund problems",
    technical: "Bugs, outages, or integration failures"
  }
  const started = yield* Clock.currentTimeMillis
  const classifyOptions: JevClassifyOptions = {
    ...(input?.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    ...(input?.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input?.maxRetries === undefined ? {} : { maxRetries: input.maxRetries })
  }
  const outcome = yield* classifyJev(request, descriptions, apiKey, classifyOptions).pipe(
    Effect.map((decision) => ({ decision }) as const),
    Effect.catch((failure) => Effect.succeed({ failure } as const))
  )
  const finished = yield* Clock.currentTimeMillis
  const latencyMs = finished - started
  if ("failure" in outcome) {
    const failed: JevLiveCheck = {
      ok: false, blocked: false, latencyMs, code: outcome.failure.code, reason: outcome.failure.message,
      ...(outcome.failure.status === undefined ? {} : { status: outcome.failure.status })
    }
    return failed
  }
  if (outcome.decision.kind === "abstained") {
    const abstained: JevLiveCheck = { ok: true, blocked: false, latencyMs, reason: outcome.decision.reason }
    return abstained
  }
  const data = yield* Schema.decodeUnknownEffect(DecisionData)(outcome.decision.data).pipe(Effect.option)
  const selected: JevLiveCheck = {
    ok: true, blocked: false, latencyMs, outcomeId: outcome.decision.outcomeId,
    ...(Option.isNone(data) ? {} : { confidence: data.value.confidence })
  }
  return selected
})

interface RetryInput {
  readonly endpoint: string
  readonly apiKey: string
  readonly body: ZenSystemOneRequest
  readonly outcomes: ReadonlyArray<string>
  readonly questionId: string
  readonly timeoutMs: number
  readonly maxRetries: number
}

interface ResolvedSettings {
  readonly endpoint: string
  readonly timeoutMs: number
  readonly maxRetries: number
  readonly questionId: string
  readonly instructions: string
}

interface PreparedDecision {
  readonly body: ZenSystemOneRequest
  readonly outcomes: ReadonlyArray<string>
}

const DecisionData = Schema.Struct({
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number
})

function resolveSettings(options?: JevClassifyOptions): Effect.Effect<ResolvedSettings, JevDecisionError> {
  return Effect.gen(function* () {
    const endpoint = options?.endpoint ?? ZenSystemOneEndpoint
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      return yield* new JevDecisionError({ code: "invalid-contract", message: "Zen endpoint is not configured" })
    }
    yield* Effect.try({
      try: () => new URL(endpoint),
      catch: () => new JevDecisionError({ code: "invalid-contract", message: "Zen endpoint is not a usable URL" })
    })
    const timeoutMs = options?.timeoutMs ?? JevDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new JevDecisionError({ code: "invalid-contract", message: "Decision timeout is out of range" })
    }
    const maxRetries = options?.maxRetries ?? JevDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new JevDecisionError({ code: "invalid-contract", message: "Decision retry budget is out of range" })
    }
    const questionId = options?.questionId ?? JevDefaultQuestionId
    if (typeof questionId !== "string" || questionId.length === 0) {
      return yield* new JevDecisionError({ code: "invalid-contract", message: "Decision question ID is not configured" })
    }
    const instructions = options?.instructions ?? JevDefaultInstructions
    if (typeof instructions !== "string" || instructions.length === 0) {
      return yield* new JevDecisionError({ code: "invalid-contract", message: "Decision instructions are not configured" })
    }
    return { endpoint, timeoutMs, maxRetries, questionId, instructions }
  })
}

function prepareDecision(request: unknown, descriptions: unknown, questionId: string, instructions: string): Effect.Effect<PreparedDecision, JevDecisionError> {
  return Effect.gen(function* () {
    const proved = yield* Schema.decodeUnknownEffect(JevDecisionRequest, { onExcessProperty: "error" })(request).pipe(
      Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Decision request does not match the automation contract" }))
    )
    const criteria = yield* buildCriteria(proved.outcomes, descriptions)
    const body = yield* Schema.decodeUnknownEffect(ZenSystemOneRequest, { onExcessProperty: "error" })({
      model: ZenJevModel, state: proved.data,
      questions: { [questionId]: { type: "choice", instructions, criteria } }
    }).pipe(
      Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Decision request does not match the Zen contract" }))
    )
    return { body, outcomes: proved.outcomes }
  })
}

function buildCriteria(outcomes: ReadonlyArray<string>, descriptions: unknown): Effect.Effect<Record<string, string>, JevDecisionError> {
  return Effect.gen(function* () {
    const proved = yield* Schema.decodeUnknownEffect(JevDescriptions, { onExcessProperty: "error" })(descriptions).pipe(
      Effect.mapError(() => new JevDecisionError({ code: "invalid-contract", message: "Decision descriptions do not match the automation contract" }))
    )
    for (const outcome of outcomes) {
      if (!Object.hasOwn(proved, outcome) || proved[outcome]!.length === 0) {
        return yield* new JevDecisionError({ code: "invalid-contract", message: `Missing description for outcome ${outcome}` })
      }
    }
    const entries: Array<[string, string]> = outcomes.map((outcome) => [outcome, proved[outcome]!])
    if (!outcomes.includes(JevAbstainChoice)) entries.push([JevAbstainChoice, "None of the listed candidates matches the input."])
    return Object.fromEntries(entries)
  })
}

function singleAttempt(state: RetryInput): Effect.Effect<JevDecisionResult, JevDecisionError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const maybe = yield* postSystemOne({ endpoint: state.endpoint, apiKey: state.apiKey, body: state.body }).pipe(
      Effect.mapError(transportFailure),
      Effect.timeoutOption(Duration.millis(state.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new JevDecisionError({ code: "timeout", message: "Jev decision exceeded its deadline" })
    }
    const answer = Object.hasOwn(maybe.value.answers, state.questionId) ? maybe.value.answers[state.questionId] : undefined
    if (answer === undefined) {
      return yield* new JevDecisionError({ code: "invalid-contract", message: "Zen omitted the requested decision answer" })
    }
    return yield* mapZenAnswerToDecision(state.outcomes, answer)
  })
}

function attemptWithRetry(state: RetryInput, attempt: number): Effect.Effect<JevDecisionResult, JevDecisionError, HttpClient.HttpClient> {
  return singleAttempt(state).pipe(
    Effect.catch((error) =>
      isRetryable(error) && attempt < state.maxRetries
        ? Effect.sleep(backoffDelay(attempt)).pipe(Effect.andThen(() => attemptWithRetry(state, attempt + 1)))
        : Effect.fail(error))
  )
}

function transportFailure(error: ZenTransportError): JevDecisionError {
  if (error.status === undefined) return new JevDecisionError({ code: error.code, message: error.message })
  return new JevDecisionError({ code: error.code, message: error.message, status: error.status })
}

function isRetryable(error: JevDecisionError): boolean {
  return error.code === "rate-limited" || error.code === "transient" || error.code === "timeout"
}

function backoffDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(100 * 2 ** attempt, 2000))
}
