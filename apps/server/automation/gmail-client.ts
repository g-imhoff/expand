import { Data, Duration, Effect, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import {
  AutomationFailure, CredentialReference, IntegrationConfiguration, PersonalScope,
  gmailIntegrationReference, sameDefinition
} from "@expand/contracts/automation"
import { GmailLabelResult, makeGmailExtension } from "@expand/contracts/automation/gmail"
import type { GmailLabelHandler } from "@expand/contracts/automation/gmail"
import { ConfigurationRepository } from "./configuration-repository.js"
import { CredentialRepository } from "./credential-repository.js"
import { GmailApiBaseUrl, GmailDefaultTimeoutMs, getMessage, getProfile, modifyMessage } from "./gmail-transport.js"
import type { GmailTransportError } from "./gmail-transport.js"

export class GmailConnectorError extends Data.TaggedError("GmailConnectorError")<{
  readonly code: "connection-failed" | "missing-credential" | "invalid-credential" | "invalid-contract" | "not-allowed" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api-error"
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}> {}

export interface GmailConnectorOptions {
  readonly baseUrl?: string
  readonly allowedMailboxes?: ReadonlyArray<string>
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

export interface GmailConnectionStatus {
  readonly reachable: boolean
  readonly authOk: boolean
  readonly emailAddress?: string
}

export interface GmailLiveCheck {
  readonly ok: boolean
  readonly blocked: boolean
  readonly reachable?: boolean
  readonly authOk?: boolean
  readonly emailAddress?: string
  readonly code?: string
  readonly reason?: string
  readonly status?: number
}

export interface GmailStoredMessage {
  readonly messageId: string
  readonly threadId?: string
  readonly labelIds: ReadonlyArray<string>
}

export const GmailCredentialSlot = "oauth"
export const GmailLegacyCredentialSlot = "token"
export const GmailDefaultMaxRetries = 2
export const GmailMaxBackoffMs = 10000

export const unionLabelIds = (existing: ReadonlyArray<string>, configured: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set(existing)
  const merged = [...existing]
  for (const label of configured) {
    if (label.length === 0 || seen.has(label)) continue
    seen.add(label)
    merged.push(label)
  }
  return merged
}

export const withoutLabelIds = (existing: ReadonlyArray<string>, remove: ReadonlyArray<string>): ReadonlyArray<string> => {
  const condemned = new Set(remove)
  return existing.filter((label) => !condemned.has(label))
}

export const resolveGmailToken = Effect.fn("GmailConnector.resolveToken")(function*(scope: unknown, integration: unknown) {
  const provedScope = yield* Schema.decodeUnknownEffect(PersonalScope, { onExcessProperty: "error" })(scope).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Credential scope does not match the automation contract" }))
  )
  const provedIntegration = yield* Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(integration).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Integration does not match the automation contract" }))
  )
  if (!sameDefinition(provedIntegration.definition, gmailIntegrationReference)) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Integration is not the Gmail connector" })
  }
  const reference = provedIntegration.credentials[GmailCredentialSlot] ?? provedIntegration.credentials[GmailLegacyCredentialSlot]
  if (reference === undefined) {
    return yield* new GmailConnectorError({ code: "missing-credential", message: "Gmail credential is not configured" })
  }
  const provedReference = yield* Schema.decodeUnknownEffect(CredentialReference, { onExcessProperty: "error" })(reference).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Credential reference does not match the automation contract" }))
  )
  const repository = yield* CredentialRepository
  const secret = yield* repository.resolveSecret(provedScope, provedReference.credentialId).pipe(
    Effect.mapError((storage) => storage.code === "missing"
      ? new GmailConnectorError({ code: "missing-credential", message: "Gmail credential is not configured" })
      : new GmailConnectorError({ code: "api-error", message: "Gmail credential lookup failed" }))
  )
  const token = extractAccessToken(secret)
  if (token === null) {
    return yield* new GmailConnectorError({ code: "invalid-credential", message: "Gmail credential is not a usable OAuth token" })
  }
  return token
})

export const applyGmailLabels = Effect.fn("GmailConnector.applyLabels")(function*(
  input: { readonly mailbox: unknown; readonly messageId: unknown; readonly addLabelIds: unknown; readonly removeLabelIds?: unknown },
  token: string,
  options: GmailConnectorOptions
) {
  if (typeof token !== "string" || token.length === 0) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail credential is not usable" })
  }
  const settings = yield* resolveConnectorSettings(options)
  const mailbox = yield* selectPermittedMailbox(input.mailbox, settings.allowedMailboxes)
  const messageId = yield* decodeConnectorMessage(input.messageId)
  const addLabelIds = yield* decodeConnectorLabels(input.addLabelIds)
  const removeLabelIds = yield* decodeOptionalConnectorLabels(input.removeLabelIds)
  return yield* attemptWithRetry({
    settings, token, mailbox, messageId, addLabelIds, removeLabelIds
  }, 0)
})

export const readGmailMessage = Effect.fn("GmailConnector.readMessage")(function*(
  input: { readonly mailbox: unknown; readonly messageId: unknown },
  token: string,
  options: GmailConnectorOptions
) {
  if (typeof token !== "string" || token.length === 0) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail credential is not usable" })
  }
  const settings = yield* resolveConnectorSettings(options)
  const mailbox = yield* selectPermittedMailbox(input.mailbox, settings.allowedMailboxes)
  const messageId = yield* decodeConnectorMessage(input.messageId)
  const snapshot = yield* readWithRetry({ settings, token, mailbox, messageId }, 0)
  const stored: GmailStoredMessage = {
    messageId: snapshot.id,
    ...(snapshot.threadId === undefined ? {} : { threadId: snapshot.threadId }),
    labelIds: snapshot.labelIds
  }
  return stored
})

export const checkGmailStatus = Effect.fn("GmailConnector.checkStatus")(function*(
  input: { readonly token: string; readonly baseUrl?: string; readonly timeoutMs?: number }
) {
  if (typeof input.token !== "string" || input.token.length === 0) {
    return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail credential is not usable" })
  }
  const settings = yield* resolveStatusSettings(input)
  const meta = yield* Effect.result(getProfile({ baseUrl: settings.baseUrl, token: input.token, timeoutMs: settings.timeoutMs }))
  if (Result.isFailure(meta)) return yield* statusFromTransport(meta.failure)
  const connected: GmailConnectionStatus = {
    reachable: true, authOk: true, emailAddress: meta.success.emailAddress
  }
  return connected
})

export const checkGmailLive = Effect.fn("GmailConnector.checkLive")(function*(
  input: { readonly scope: unknown; readonly integration: unknown; readonly options: GmailConnectorOptions }
) {
  const resolved = yield* Effect.result(resolveGmailToken(input.scope, input.integration))
  if (Result.isFailure(resolved)) {
    if (resolved.failure.code === "missing-credential") {
      const blocked: GmailLiveCheck = { ok: false, blocked: true, reason: resolved.failure.message }
      return blocked
    }
    const failed: GmailLiveCheck = {
      ok: false, blocked: false, code: resolved.failure.code, reason: resolved.failure.message,
      ...(resolved.failure.status === undefined ? {} : { status: resolved.failure.status })
    }
    return failed
  }
  const configured = yield* Effect.result(resolveConnectorSettings(input.options))
  if (Result.isFailure(configured)) {
    const invalid: GmailLiveCheck = { ok: false, blocked: false, code: configured.failure.code, reason: configured.failure.message }
    return invalid
  }
  const proved = yield* Effect.result(Schema.decodeUnknownEffect(IntegrationConfiguration, { onExcessProperty: "error" })(input.integration))
  if (Result.isFailure(proved)) {
    const invalid: GmailLiveCheck = { ok: false, blocked: false, code: "invalid-contract", reason: "Integration does not match the automation contract" }
    return invalid
  }
  const mailbox = yield* Effect.result(selectPermittedMailbox(
    mailboxOf(proved.success.configuration),
    configured.success.allowedMailboxes
  ))
  if (Result.isFailure(mailbox)) {
    const denied: GmailLiveCheck = { ok: false, blocked: false, code: mailbox.failure.code, reason: mailbox.failure.message }
    return denied
  }
  const status = yield* checkGmailStatus({ token: resolved.success, baseUrl: configured.success.baseUrl, timeoutMs: configured.success.timeoutMs })
  const checked: GmailLiveCheck = {
    ok: status.reachable && status.authOk, blocked: false, reachable: status.reachable, authOk: status.authOk,
    ...(status.emailAddress === undefined ? {} : { emailAddress: status.emailAddress }),
    ...(!status.reachable || status.authOk ? {} : { code: "auth", reason: "Gmail rejected the credential" })
  }
  return checked
})

export const redactedGmailStatus = (status: GmailConnectionStatus): GmailConnectionStatus => ({
  reachable: status.reachable,
  authOk: status.authOk,
  ...(status.emailAddress === undefined ? {} : { emailAddress: status.emailAddress })
})

export const makeGmailServerExtension = (options: GmailConnectorOptions) => {
  const handler: GmailLabelHandler<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient> = (args, configuration, context) =>
    Effect.gen(function*() {
      const configurations = yield* ConfigurationRepository
      const stored = yield* configurations.getIntegration(context.scope, context.integrationId).pipe(
        Effect.mapError((storage) => connectorFailure(new GmailConnectorError({ code: storage.code === "missing" ? "missing-credential" : "api-error", message: "Gmail integration lookup failed" })))
      )
      if (stored === null) {
        return yield* Effect.fail(connectorFailure(new GmailConnectorError({ code: "missing-credential", message: "Gmail integration is not configured" })))
      }
      const token = yield* resolveGmailToken(context.scope, stored.configuration).pipe(Effect.mapError(connectorFailure))
      return yield* applyGmailLabels({ mailbox: mailboxOf(configuration), messageId: args.messageId, addLabelIds: [...args.addLabelIds], ...(args.removeLabelIds === undefined ? {} : { removeLabelIds: [...args.removeLabelIds] }) }, token, options).pipe(
        Effect.mapError(connectorFailure)
      )
    })
  return makeGmailExtension(handler)
}

interface ConnectorSettings {
  readonly baseUrl: string
  readonly allowedMailboxes: ReadonlyArray<string> | undefined
  readonly timeoutMs: number
  readonly maxRetries: number
}

interface RetryState {
  readonly settings: ConnectorSettings
  readonly token: string
  readonly mailbox: string
  readonly messageId: string
  readonly addLabelIds: ReadonlyArray<string>
  readonly removeLabelIds: ReadonlyArray<string> | undefined
}

const GmailMailboxSchema = Schema.Struct({ mailbox: Schema.optional(Schema.String.check(Schema.isMinLength(1))) })
const GmailMessageSchema = Schema.String.check(Schema.isMinLength(1))
const GmailLabelsSchema = Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1))

function extractAccessToken(secret: unknown): string | null {
  if (typeof secret === "string" && secret.length > 0) return secret
  if (typeof secret === "object" && secret !== null && !Array.isArray(secret)) {
    const record = secret as Record<string, unknown>
    const candidates = [record["accessToken"], record["access_token"], record["token"]]
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate
    }
  }
  return null
}

function mailboxOf(configuration: unknown): unknown {
  if (typeof configuration === "object" && configuration !== null && "mailbox" in configuration) {
    return (configuration as Record<string, unknown>)["mailbox"]
  }
  return undefined
}

function resolveConnectorSettings(options: GmailConnectorOptions): Effect.Effect<ConnectorSettings, GmailConnectorError> {
  return Effect.gen(function*() {
    const baseUrl = options.baseUrl ?? GmailApiBaseUrl
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unusable Gmail endpoint")
      },
      catch: () => new GmailConnectorError({ code: "invalid-contract", message: "Gmail endpoint is not a usable URL" })
    })
    if (options.allowedMailboxes !== undefined && !Array.isArray(options.allowedMailboxes)) {
      return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail mailbox allow-list is not usable" })
    }
    const allowedMailboxes: Array<string> | undefined = options.allowedMailboxes === undefined ? undefined : []
    if (allowedMailboxes !== undefined) {
      for (const entry of options.allowedMailboxes!) {
        if (typeof entry !== "string" || entry.length === 0) {
          return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail mailbox allow-list is not usable" })
        }
        allowedMailboxes.push(entry)
      }
    }
    const timeoutMs = options.timeoutMs ?? GmailDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail timeout is out of range" })
    }
    const maxRetries = options.maxRetries ?? GmailDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail retry budget is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/u, ""), allowedMailboxes, timeoutMs, maxRetries }
  })
}

function resolveStatusSettings(input: { readonly baseUrl?: string; readonly timeoutMs?: number }): Effect.Effect<{ readonly baseUrl: string; readonly timeoutMs: number }, GmailConnectorError> {
  return Effect.gen(function*() {
    const baseUrl = input.baseUrl ?? GmailApiBaseUrl
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unusable Gmail endpoint")
      },
      catch: () => new GmailConnectorError({ code: "invalid-contract", message: "Gmail endpoint is not a usable URL" })
    })
    const timeoutMs = input.timeoutMs ?? GmailDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GmailConnectorError({ code: "invalid-contract", message: "Gmail timeout is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/u, ""), timeoutMs }
  })
}

function selectPermittedMailbox(
  configuration: unknown, allowedMailboxes: ReadonlyArray<string> | undefined
): Effect.Effect<string, GmailConnectorError> {
  return Effect.gen(function*() {
    const raw = typeof configuration === "string" ? { mailbox: configuration } : (configuration ?? {})
    const proved = yield* Schema.decodeUnknownEffect(GmailMailboxSchema)(raw).pipe(
      Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Gmail mailbox does not match the automation contract" }))
    )
    const mailbox = proved.mailbox ?? "me"
    if (allowedMailboxes === undefined) return mailbox
    if (!allowedMailboxes.includes(mailbox)) {
      return yield* new GmailConnectorError({ code: "not-allowed", message: "Gmail mailbox is not permitted" })
    }
    return mailbox
  })
}

function decodeConnectorMessage(value: unknown): Effect.Effect<string, GmailConnectorError> {
  return Schema.decodeUnknownEffect(GmailMessageSchema)(value).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Gmail message id is not usable" }))
  )
}

function decodeConnectorLabels(value: unknown): Effect.Effect<ReadonlyArray<string>, GmailConnectorError> {
  return Schema.decodeUnknownEffect(GmailLabelsSchema)(value).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Gmail labels are not usable" }))
  )
}

function decodeOptionalConnectorLabels(value: unknown): Effect.Effect<ReadonlyArray<string> | undefined, GmailConnectorError> {
  return Schema.decodeUnknownEffect(Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))))(value).pipe(
    Effect.mapError(() => new GmailConnectorError({ code: "invalid-contract", message: "Gmail labels are not usable" }))
  )
}

function mapTransportError(error: GmailTransportError): GmailConnectorError {
  return new GmailConnectorError({
    code: error.code, message: error.message,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
  })
}

function statusFromTransport(error: GmailTransportError): Effect.Effect<GmailConnectionStatus, GmailConnectorError> {
  if (error.code === "connection-failed") {
    return Effect.succeed({ reachable: false, authOk: false })
  }
  if (error.code === "auth") {
    return Effect.succeed({ reachable: true, authOk: false })
  }
  if (error.code === "rate-limited" || error.code === "forbidden" || error.code === "not-found" || error.code === "api-error") {
    return Effect.succeed({ reachable: true, authOk: true })
  }
  return Effect.fail(mapTransportError(error))
}

function isRetryable(error: GmailConnectorError): boolean {
  return error.code === "rate-limited" || error.code === "connection-failed" ||
    (error.code === "api-error" && (error.status === undefined || error.status >= 500))
}

function backoffDelay(error: GmailConnectorError, attempt: number): Duration.Duration {
  return Duration.millis(Math.min(error.retryAfterMs ?? 100 * 2 ** attempt, GmailMaxBackoffMs))
}

function attemptWithRetry(state: RetryState, attempt: number): Effect.Effect<typeof GmailLabelResult.Type, GmailConnectorError, HttpClient.HttpClient> {
  return Effect.gen(function*() {
    const snapshot = yield* getMessage({ baseUrl: state.settings.baseUrl, token: state.token, userId: state.mailbox, messageId: state.messageId, timeoutMs: state.settings.timeoutMs }).pipe(
      Effect.mapError(mapTransportError)
    )
    const withAdded = unionLabelIds(snapshot.labelIds, state.addLabelIds)
    const merged = state.removeLabelIds === undefined ? withAdded : withoutLabelIds(withAdded, state.removeLabelIds)
    const unchanged = merged.length === snapshot.labelIds.length && merged.every((label, index) => label === snapshot.labelIds[index])
    if (unchanged) return { applied: false }
    const add = state.addLabelIds.filter((label) => !snapshot.labelIds.includes(label))
    const remove = state.removeLabelIds === undefined ? [] : snapshot.labelIds.filter((label) => state.removeLabelIds!.includes(label))
    if (add.length === 0 && remove.length === 0) return { applied: false }
    yield* modifyMessage({
      baseUrl: state.settings.baseUrl, token: state.token, userId: state.mailbox,
      messageId: state.messageId, addLabelIds: add, ...(remove.length === 0 ? {} : { removeLabelIds: remove }),
      timeoutMs: state.settings.timeoutMs
    }).pipe(Effect.mapError(mapTransportError))
    return { applied: true }
  }).pipe(
    Effect.catch((error) => isRetryable(error) && attempt < state.settings.maxRetries
      ? Effect.sleep(backoffDelay(error, attempt)).pipe(Effect.andThen(() => attemptWithRetry(state, attempt + 1)))
      : Effect.fail(error))
  )
}

function readWithRetry(state: Omit<RetryState, "addLabelIds" | "removeLabelIds">, attempt: number): Effect.Effect<{ readonly id: string; readonly threadId?: string; readonly labelIds: ReadonlyArray<string> }, GmailConnectorError, HttpClient.HttpClient> {
  return getMessage({
    baseUrl: state.settings.baseUrl, token: state.token,
    userId: state.mailbox, messageId: state.messageId, timeoutMs: state.settings.timeoutMs
  }).pipe(
    Effect.mapError(mapTransportError),
    Effect.catch((error) => isRetryable(error) && attempt < state.settings.maxRetries
      ? Effect.sleep(backoffDelay(error, attempt)).pipe(Effect.andThen(() => readWithRetry(state, attempt + 1)))
      : Effect.fail(error))
  )
}

function connectorFailure(error: GmailConnectorError): typeof AutomationFailure.Type {
  return {
    code: error.code, message: error.message,
    ...(error.status === undefined ? {} : { details: { status: error.status } })
  }
}
