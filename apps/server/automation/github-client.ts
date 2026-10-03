import { Data, Duration, Effect, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationFailure, CredentialReference, GithubRepositoryConfiguration, IntegrationConfiguration, PersonalScope,
  githubIntegrationReference, sameDefinition
} from "@expand/contracts/automation"
import { GithubLabelResult, makeGithubExtension } from "@expand/contracts/automation/github"
import type { GithubLabelHandler } from "@expand/contracts/automation/github"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { GithubApiBaseUrl, GithubDefaultTimeoutMs, getRepositoryLabels, readIssue, readRateLimit, writeIssueLabels } from "./github-transport.js"
import type { GithubIssueSnapshot, GithubTransportError } from "./github-transport.js"

export class GithubConnectorError extends Data.TaggedError("GithubConnectorError")<{
  readonly code: "connection-failed" | "missing-credential" | "invalid-credential" | "invalid-contract" | "not-allowed" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api-error"
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}> {}

export interface GithubAllowedRepository {
  readonly owner: string
  readonly repo: string
}

export interface GithubConnectorOptions {
  readonly baseUrl?: string
  readonly allowedRepos?: ReadonlyArray<GithubAllowedRepository>
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

export interface GithubConnectionStatus {
  readonly reachable: boolean
  readonly authOk: boolean
  readonly scopes: ReadonlyArray<string>
  readonly rateLimit?: {
    readonly limit: number
    readonly remaining: number
    readonly reset: number
  }
}

export interface GithubLiveCheck {
  readonly ok: boolean
  readonly blocked: boolean
  readonly reachable?: boolean
  readonly authOk?: boolean
  readonly scopes?: ReadonlyArray<string>
  readonly code?: string
  readonly reason?: string
  readonly status?: number
}

export interface GithubStoredIssue {
  readonly issueNumber: number
  readonly title: string
  readonly body?: string
  readonly labels: ReadonlyArray<string>
}

export const GithubCredentialSlot = "token"
export const GithubDefaultMaxRetries = 2
export const GithubMaxBackoffMs = 10000

export const unionLabels = (existing: ReadonlyArray<string>, configured: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set(existing.map((label) => label.toLowerCase()))
  const merged = [...existing]
  for (const label of configured) {
    const key = label.toLowerCase()
    if (label.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(label)
  }
  return merged
}

export const resolveGithubToken = Effect.fn("GithubConnector.resolveToken")(function*(scope: unknown, integration: unknown) {
  const provedScope = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Credential scope does not match the automation contract" }))
  )
  const provedIntegration = yield* Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(integration).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Integration does not match the automation contract" }))
  )
  if (!sameDefinition(provedIntegration.definition, githubIntegrationReference)) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "Integration is not the GitHub connector" })
  }
  const reference = provedIntegration.credentials[GithubCredentialSlot]
  if (reference === undefined) {
    return yield* new GithubConnectorError({ code: "missing-credential", message: "GitHub credential is not configured" })
  }
  const provedReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(reference).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "Credential reference does not match the automation contract" }))
  )
  const repository = yield* CredentialRepository
  const secret = yield* repository.resolveSecret(provedScope, provedReference.credentialId).pipe(
    Effect.mapError((storage) => storage.code === "missing"
      ? new GithubConnectorError({ code: "missing-credential", message: "GitHub credential is not configured" })
      : new GithubConnectorError({ code: "api-error", message: "GitHub credential lookup failed" }))
  )
  if (typeof secret !== "string" || secret.length === 0) {
    return yield* new GithubConnectorError({ code: "invalid-credential", message: "GitHub credential is not a usable token" })
  }
  return secret
})

export const applyGithubLabels = Effect.fn("GithubConnector.applyLabels")(function*(
  input: { readonly repository: unknown; readonly issueNumber: unknown; readonly labels: unknown },
  token: string,
  options: GithubConnectorOptions
) {
  if (typeof token !== "string" || token.length === 0) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub token is not usable" })
  }
  const settings = yield* resolveConnectorSettings(options)
  const repository = yield* selectPermittedRepository(input.repository, settings.allowedRepos)
  const issueNumber = yield* decodeConnectorIssue(input.issueNumber)
  const labels = yield* decodeConnectorLabels(input.labels)
  return yield* attemptWithRetry({
    settings, token, repository, issueNumber,
    read: (state) => readIssue({ baseUrl: state.settings.baseUrl, token: state.token, owner: state.repository.owner, repo: state.repository.repo, issueNumber: state.issueNumber, timeoutMs: state.settings.timeoutMs }),
    write: (state, merged) => writeIssueLabels({ baseUrl: state.settings.baseUrl, token: state.token, owner: state.repository.owner, repo: state.repository.repo, issueNumber: state.issueNumber, labels: merged, timeoutMs: state.settings.timeoutMs }),
    labels
  }, 0)
})

export const readGithubIssue = Effect.fn("GithubConnector.readIssue")(function*(
  input: { readonly repository: unknown; readonly issueNumber: unknown },
  token: string,
  options: GithubConnectorOptions
) {
  if (typeof token !== "string" || token.length === 0) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub token is not usable" })
  }
  const settings = yield* resolveConnectorSettings(options)
  const repository = yield* selectPermittedRepository(input.repository, settings.allowedRepos)
  const issueNumber = yield* decodeConnectorIssue(input.issueNumber)
  const snapshot = yield* readWithRetry({ settings, token, repository, issueNumber }, 0)
  const stored: GithubStoredIssue = {
    issueNumber,
    title: snapshot.title,
    ...(snapshot.body === undefined ? {} : { body: snapshot.body }),
    labels: snapshot.labels
  }
  return stored
})

export const listGithubLabels = Effect.fn("GithubConnector.listLabels")(function*(
  input: { readonly repository: unknown },
  token: string,
  options: GithubConnectorOptions
) {
  if (typeof token !== "string" || token.length === 0) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub token is not usable" })
  }
  const settings = yield* resolveConnectorSettings(options)
  const repository = yield* selectPermittedRepository(input.repository, settings.allowedRepos)
  return yield* labelsWithRetry({ settings, token, repository }, 0)
})

export const checkGithubStatus = Effect.fn("GithubConnector.checkStatus")(function*(
  input: { readonly token: string; readonly baseUrl?: string; readonly timeoutMs?: number }
) {
  if (typeof input.token !== "string" || input.token.length === 0) {
    return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub token is not usable" })
  }
  const settings = yield* resolveStatusSettings(input)
  const meta = yield* Effect.result(readRateLimit({ baseUrl: settings.baseUrl, token: input.token, timeoutMs: settings.timeoutMs }))
  if (Result.isFailure(meta)) return yield* statusFromTransport(meta.failure)
  const connected: GithubConnectionStatus = {
    reachable: true, authOk: true, scopes: meta.success.scopes,
    ...(meta.success.rateLimit === undefined ? {} : { rateLimit: meta.success.rateLimit })
  }
  return connected
})

export const checkGithubLive = Effect.fn("GithubConnector.checkLive")(function*(
  input: { readonly scope: unknown; readonly integration: unknown; readonly options: GithubConnectorOptions }
) {
  const resolved = yield* Effect.result(resolveGithubToken(input.scope, input.integration))
  if (Result.isFailure(resolved)) {
    if (resolved.failure.code === "missing-credential") {
      const blocked: GithubLiveCheck = { ok: false, blocked: true, reason: resolved.failure.message }
      return blocked
    }
    const failed: GithubLiveCheck = {
      ok: false, blocked: false, code: resolved.failure.code, reason: resolved.failure.message,
      ...(resolved.failure.status === undefined ? {} : { status: resolved.failure.status })
    }
    return failed
  }
  const configured = yield* Effect.result(resolveConnectorSettings(input.options))
  if (Result.isFailure(configured)) {
    const invalid: GithubLiveCheck = { ok: false, blocked: false, code: configured.failure.code, reason: configured.failure.message }
    return invalid
  }
  const proved = yield* Effect.result(Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(input.integration))
  if (Result.isFailure(proved)) {
    const invalid: GithubLiveCheck = { ok: false, blocked: false, code: "invalid-contract", reason: "Integration does not match the automation contract" }
    return invalid
  }
  const repository = yield* Effect.result(selectPermittedRepository(proved.success.configuration, configured.success.allowedRepos))
  if (Result.isFailure(repository)) {
    const denied: GithubLiveCheck = { ok: false, blocked: false, code: repository.failure.code, reason: repository.failure.message }
    return denied
  }
  const status = yield* checkGithubStatus({ token: resolved.success, baseUrl: configured.success.baseUrl, timeoutMs: configured.success.timeoutMs })
  const checked: GithubLiveCheck = {
    ok: status.reachable && status.authOk, blocked: false, reachable: status.reachable, authOk: status.authOk, scopes: status.scopes,
    ...(!status.reachable || status.authOk ? {} : { code: "auth", reason: "GitHub rejected the token" })
  }
  return checked
})

export const makeGithubServerExtension = (options: GithubConnectorOptions) => {
  const handler: GithubLabelHandler<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient> = (args, configuration, context) =>
    Effect.gen(function*() {
      const configurations = yield* ConfigurationRepository
      const stored = yield* configurations.getIntegration(context.scope, context.integrationId).pipe(
        Effect.mapError((storage) => connectorFailure(new GithubConnectorError({ code: storage.code === "missing" ? "missing-credential" : "api-error", message: "GitHub integration lookup failed" })))
      )
      if (stored === null) {
        return yield* Effect.fail(connectorFailure(new GithubConnectorError({ code: "missing-credential", message: "GitHub integration is not configured" })))
      }
      const token = yield* resolveGithubToken(context.scope, stored.configuration).pipe(Effect.mapError(connectorFailure))
      return yield* applyGithubLabels({ repository: configuration, issueNumber: args.issueNumber, labels: [args.label] }, token, options).pipe(
        Effect.mapError(connectorFailure)
      )
    })
  return makeGithubExtension(handler)
}

interface ConnectorSettings {
  readonly baseUrl: string
  readonly allowedRepos: ReadonlyArray<GithubAllowedRepository> | undefined
  readonly timeoutMs: number
  readonly maxRetries: number
}

interface RetryState {
  readonly settings: ConnectorSettings
  readonly token: string
  readonly repository: typeof GithubRepositoryConfiguration.Type
  readonly issueNumber: number
}

const GithubRepositorySchema = Schema.Struct({
  owner: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isMinLength(1))
})
const GithubLabelsSchema = Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1))
const GithubIssueNumberSchema = Schema.Int.check(Schema.isGreaterThan(0))

function resolveConnectorSettings(options: GithubConnectorOptions): Effect.Effect<ConnectorSettings, GithubConnectorError> {
  return Effect.gen(function*() {
    const baseUrl = options.baseUrl ?? GithubApiBaseUrl
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unusable GitHub endpoint")
      },
      catch: () => new GithubConnectorError({ code: "invalid-contract", message: "GitHub endpoint is not a usable URL" })
    })
    if (options.allowedRepos !== undefined && !Array.isArray(options.allowedRepos)) {
      return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub repository allow-list is not usable" })
    }
    const allowedRepos: Array<GithubAllowedRepository> | undefined = options.allowedRepos === undefined ? undefined : []
    if (allowedRepos !== undefined) {
      for (const entry of options.allowedRepos!) {
        const proved = yield* Schema.decodeUnknownEffect(GithubRepositorySchema)(entry).pipe(
          Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "GitHub repository allow-list is not usable" }))
        )
        allowedRepos.push({ owner: proved.owner, repo: proved.repo })
      }
    }
    const timeoutMs = options.timeoutMs ?? GithubDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub timeout is out of range" })
    }
    const maxRetries = options.maxRetries ?? GithubDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub retry budget is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/u, ""), allowedRepos, timeoutMs, maxRetries }
  })
}

function resolveStatusSettings(input: { readonly baseUrl?: string; readonly timeoutMs?: number }): Effect.Effect<{ readonly baseUrl: string; readonly timeoutMs: number }, GithubConnectorError> {
  return Effect.gen(function*() {
    const baseUrl = input.baseUrl ?? GithubApiBaseUrl
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unusable GitHub endpoint")
      },
      catch: () => new GithubConnectorError({ code: "invalid-contract", message: "GitHub endpoint is not a usable URL" })
    })
    const timeoutMs = input.timeoutMs ?? GithubDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GithubConnectorError({ code: "invalid-contract", message: "GitHub timeout is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/u, ""), timeoutMs }
  })
}

function selectPermittedRepository(
  configuration: unknown, allowedRepos: ReadonlyArray<GithubAllowedRepository> | undefined
): Effect.Effect<typeof GithubRepositoryConfiguration.Type, GithubConnectorError> {
  return Effect.gen(function*() {
    const proved = yield* Schema.decodeUnknownEffect(GithubRepositoryConfiguration, { onExcessProperty: "error" })(configuration).pipe(
      Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "GitHub repository does not match the automation contract" }))
    )
    if (allowedRepos === undefined) return proved
    const permitted = allowedRepos.some((entry) => entry.owner === proved.owner && entry.repo === proved.repo)
    if (!permitted) {
      return yield* new GithubConnectorError({ code: "not-allowed", message: "GitHub repository is not permitted" })
    }
    return proved
  })
}

function decodeConnectorIssue(value: unknown): Effect.Effect<number, GithubConnectorError> {
  return Schema.decodeUnknownEffect(GithubIssueNumberSchema)(value).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "GitHub issue number is not usable" }))
  )
}

function decodeConnectorLabels(value: unknown): Effect.Effect<ReadonlyArray<string>, GithubConnectorError> {
  return Schema.decodeUnknownEffect(GithubLabelsSchema)(value).pipe(
    Effect.mapError(() => new GithubConnectorError({ code: "invalid-contract", message: "GitHub labels are not usable" }))
  )
}

function mapTransportError(error: GithubTransportError): GithubConnectorError {
  return new GithubConnectorError({
    code: error.code, message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
  })
}

function statusFromTransport(error: GithubTransportError): Effect.Effect<GithubConnectionStatus, GithubConnectorError> {
  if (error.code === "connection-failed") {
    return Effect.succeed({ reachable: false, authOk: false, scopes: [] })
  }
  if (error.code === "auth") {
    return Effect.succeed({ reachable: true, authOk: false, scopes: [] })
  }
  if (error.code === "rate-limited" || error.code === "forbidden" || error.code === "not-found" || error.code === "api-error") {
    return Effect.succeed({ reachable: true, authOk: true, scopes: [] })
  }
  return Effect.fail(mapTransportError(error))
}

function isRetryable(error: GithubConnectorError): boolean {
  return error.code === "rate-limited" || error.code === "connection-failed" ||
    (error.code === "api-error" && (error.status === undefined || error.status >= 500))
}

function backoffDelay(error: GithubConnectorError, attempt: number): Duration.Duration {
  return Duration.millis(Math.min(error.retryAfterMs ?? 100 * 2 ** attempt, GithubMaxBackoffMs))
}

function attemptWithRetry(state: RetryState & {
  readonly read: (state: RetryState) => Effect.Effect<{ readonly labels: ReadonlyArray<string> }, GithubTransportError, HttpClient.HttpClient>
  readonly write: (state: RetryState, merged: ReadonlyArray<string>) => Effect.Effect<unknown, GithubTransportError, HttpClient.HttpClient>
  readonly labels: ReadonlyArray<string>
}, attempt: number): Effect.Effect<typeof GithubLabelResult.Type, GithubConnectorError, HttpClient.HttpClient> {
  return Effect.gen(function*() {
    const snapshot = yield* state.read(state).pipe(Effect.mapError(mapTransportError))
    const merged = unionLabels(snapshot.labels, state.labels)
    if (merged.length === snapshot.labels.length) return { applied: false }
    yield* state.write(state, merged).pipe(Effect.mapError(mapTransportError))
    return { applied: true }
  }).pipe(
    Effect.catch((error) => isRetryable(error) && attempt < state.settings.maxRetries
      ? Effect.sleep(backoffDelay(error, attempt)).pipe(Effect.andThen(() => attemptWithRetry(state, attempt + 1)))
      : Effect.fail(error))
  )
}

function readWithRetry(state: RetryState, attempt: number): Effect.Effect<GithubIssueSnapshot, GithubConnectorError, HttpClient.HttpClient> {
  return readIssue({
    baseUrl: state.settings.baseUrl, token: state.token,
    owner: state.repository.owner, repo: state.repository.repo,
    issueNumber: state.issueNumber, timeoutMs: state.settings.timeoutMs
  }).pipe(
    Effect.mapError(mapTransportError),
    Effect.catch((error) => isRetryable(error) && attempt < state.settings.maxRetries
      ? Effect.sleep(backoffDelay(error, attempt)).pipe(Effect.andThen(() => readWithRetry(state, attempt + 1)))
      : Effect.fail(error))
  )
}

function labelsWithRetry(state: Omit<RetryState, "issueNumber">, attempt: number): Effect.Effect<ReadonlyArray<string>, GithubConnectorError, HttpClient.HttpClient> {
  return getRepositoryLabels({
    baseUrl: state.settings.baseUrl, token: state.token,
    owner: state.repository.owner, repo: state.repository.repo, timeoutMs: state.settings.timeoutMs
  }).pipe(
    Effect.mapError(mapTransportError),
    Effect.catch((error) => isRetryable(error) && attempt < state.settings.maxRetries
      ? Effect.sleep(backoffDelay(error, attempt)).pipe(Effect.andThen(() => labelsWithRetry(state, attempt + 1)))
      : Effect.fail(error))
  )
}

function connectorFailure(error: GithubConnectorError): typeof AutomationFailure.Type {
  return {
    code: error.code, message: error.message,
    ...(error.status === undefined ? {} : { details: { status: error.status } })
  }
}
