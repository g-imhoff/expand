import { Clock, Data, Duration, Effect, Option, Schema } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"

export class GmailTransportError extends Data.TaggedError("GmailTransportError")<{
  readonly code: "connection-failed" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api-error" | "invalid-contract"
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}> {}

export interface GmailMessageRef {
  readonly id: string
  readonly threadId?: string
}

export interface GmailMessageSnapshot {
  readonly id: string
  readonly threadId?: string
  readonly labelIds: ReadonlyArray<string>
  readonly snippet?: string
  readonly subject?: string
  readonly from?: string
  readonly body?: string
  readonly historyId?: string
}

export interface GmailProfile {
  readonly emailAddress: string
  readonly historyId?: string
}

export interface GmailListPage {
  readonly messages: ReadonlyArray<GmailMessageRef>
  readonly nextPageToken?: string
  readonly resultSizeEstimate?: number
}

export const GmailApiBaseUrl = "https://gmail.googleapis.com"
export const GmailDefaultTimeoutMs = 10000
export const GmailMaxListPages = 10

export const listMessages = Effect.fn("GmailTransport.listMessages")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly userId?: unknown; readonly query?: unknown; readonly pageToken?: unknown; readonly maxResults?: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const userId = yield* decodeUserId(input.userId)
  const query = yield* decodeOptionalQuery(input.query)
  const pageToken = yield* decodeOptionalToken(input.pageToken)
  const maxResults = yield* decodeOptionalMax(input.maxResults)
  const params = new URLSearchParams()
  if (query !== undefined) params.set("q", query)
  if (pageToken !== undefined) params.set("pageToken", pageToken)
  if (maxResults !== undefined) params.set("maxResults", String(maxResults))
  const suffix = params.size === 0 ? "" : `?${params.toString()}`
  const response = yield* sendGmailRequest({ settings, method: "GET", path: `/gmail/v1/users/${encodeURIComponent(userId)}/messages${suffix}` })
  return yield* decodeListPage(response.body, response.status)
})

export const getMessage = Effect.fn("GmailTransport.getMessage")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly userId?: unknown; readonly messageId: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const userId = yield* decodeUserId(input.userId)
  const messageId = yield* decodeMessageId(input.messageId)
  const response = yield* sendGmailRequest({ settings, method: "GET", path: `/gmail/v1/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}?format=full` })
  return yield* decodeMessageShape(response.body, response.status)
})

export const modifyMessage = Effect.fn("GmailTransport.modifyMessage")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly userId?: unknown; readonly messageId: unknown; readonly addLabelIds: unknown; readonly removeLabelIds?: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const userId = yield* decodeUserId(input.userId)
  const messageId = yield* decodeMessageId(input.messageId)
  const addLabelIds = yield* decodeLabelIds(input.addLabelIds)
  const removeLabelIds = yield* decodeOptionalLabelIds(input.removeLabelIds)
  const response = yield* sendGmailRequest({
    settings, method: "POST", path: `/gmail/v1/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}/modify`,
    body: { addLabelIds: [...addLabelIds], ...(removeLabelIds === undefined ? {} : { removeLabelIds: [...removeLabelIds] }) }
  })
  return yield* decodeModifyShape(response.body, response.status)
})

export const getProfile = Effect.fn("GmailTransport.getProfile")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly userId?: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const userId = yield* decodeUserId(input.userId)
  const response = yield* sendGmailRequest({ settings, method: "GET", path: `/gmail/v1/users/${encodeURIComponent(userId)}/profile` })
  return yield* decodeProfileShape(response.body, response.status)
})

interface TransportSettings {
  readonly baseUrl: string
  readonly token: string
  readonly timeoutMs: number
}

interface GmailResponse {
  readonly status: number
  readonly scopes: ReadonlyArray<string>
  readonly retryAfter: number | undefined
  readonly body: unknown
}

const GmailListShape = Schema.Struct({
  messages: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String.check(Schema.isMinLength(1)),
    threadId: Schema.optional(Schema.String.check(Schema.isMinLength(1)))
  }))),
  nextPageToken: Schema.optional(Schema.String),
  resultSizeEstimate: Schema.optional(Schema.Number)
})
const GmailHeader = Schema.Struct({ name: Schema.String, value: Schema.String })
const GmailMessageShape = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  threadId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  snippet: Schema.optional(Schema.String),
  historyId: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  payload: Schema.optional(Schema.Struct({
    headers: Schema.optional(Schema.Array(GmailHeader)),
    body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
    parts: Schema.optional(Schema.Array(Schema.Unknown))
  }))
})
const GmailModifyShape = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  threadId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  labelIds: Schema.optional(Schema.Array(Schema.String))
})
const GmailProfileShape = Schema.Struct({
  emailAddress: Schema.String.check(Schema.isMinLength(1)),
  historyId: Schema.optional(Schema.Union([Schema.String, Schema.Number]))
})
const GmailModifyBody = Schema.Struct({
  addLabelIds: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  removeLabelIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
})

function resolveTransportSettings(input: {
  readonly baseUrl: unknown
  readonly token: unknown
  readonly timeoutMs?: number
}): Effect.Effect<TransportSettings, GmailTransportError> {
  return Effect.gen(function*() {
    const baseUrl = input.baseUrl
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail endpoint is not configured" })
    }
    const origin = yield* Effect.try({
      try: () => new URL(baseUrl),
      catch: () => new GmailTransportError({ code: "invalid-contract", message: "Gmail endpoint is not a usable URL" })
    })
    if (origin.protocol !== "https:" && origin.protocol !== "http:") {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail endpoint is not a usable URL" })
    }
    const token = input.token
    if (typeof token !== "string" || token.length === 0) {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail credential is not usable" })
    }
    const timeoutMs = input.timeoutMs ?? GmailDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail timeout is out of range" })
    }
    return { baseUrl: origin.toString().replace(/\/+$/u, ""), token, timeoutMs }
  })
}

function decodeUserId(value: unknown): Effect.Effect<string, GmailTransportError> {
  if (value === undefined) return Effect.succeed("me")
  return Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail user reference is not usable" }))
  )
}

function decodeMessageId(value: unknown): Effect.Effect<string, GmailTransportError> {
  return Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1)))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail message id is not usable" }))
  )
}

function decodeOptionalQuery(value: unknown): Effect.Effect<string | undefined, GmailTransportError> {
  return Schema.decodeUnknownEffect(Schema.optional(Schema.String))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail query is not usable" }))
  )
}

function decodeOptionalToken(value: unknown): Effect.Effect<string | undefined, GmailTransportError> {
  return Schema.decodeUnknownEffect(Schema.optional(Schema.String.check(Schema.isMinLength(1))))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail page token is not usable" }))
  )
}

function decodeOptionalMax(value: unknown): Effect.Effect<number | undefined, GmailTransportError> {
  return Schema.decodeUnknownEffect(Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500))))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail page size is out of range" }))
  )
}

function decodeLabelIds(value: unknown): Effect.Effect<ReadonlyArray<string>, GmailTransportError> {
  return Schema.decodeUnknownEffect(Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1)))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail labels are not usable" }))
  )
}

function decodeOptionalLabelIds(value: unknown): Effect.Effect<ReadonlyArray<string> | undefined, GmailTransportError> {
  return Schema.decodeUnknownEffect(Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))))(value).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail labels are not usable" }))
  )
}

function decodeListPage(body: unknown, status: number): Effect.Effect<GmailListPage, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailListShape)(body).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail response does not match its contract", status })),
    Effect.map((parsed) => ({
      messages: (parsed.messages ?? []) as ReadonlyArray<GmailMessageRef>,
      ...(parsed.nextPageToken === undefined ? {} : { nextPageToken: parsed.nextPageToken }),
      ...(parsed.resultSizeEstimate === undefined ? {} : { resultSizeEstimate: parsed.resultSizeEstimate })
    }))
  )
}

function decodeMessageShape(body: unknown, status: number): Effect.Effect<GmailMessageSnapshot, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailMessageShape)(body).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail response does not match its contract", status })),
    Effect.map((parsed) => {
      const headers = parsed.payload?.headers ?? []
      const subject = headers.find((entry) => entry.name.toLowerCase() === "subject")?.value
      const from = headers.find((entry) => entry.name.toLowerCase() === "from")?.value
      const snapshot: GmailMessageSnapshot = {
        id: parsed.id,
        ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
        labelIds: (parsed.labelIds ?? []) as ReadonlyArray<string>,
        ...(parsed.snippet === undefined ? {} : { snippet: parsed.snippet }),
        ...(subject === undefined ? {} : { subject }),
        ...(from === undefined ? {} : { from }),
        ...(parsed.payload?.body?.data === undefined ? {} : { body: parsed.payload.body.data }),
        ...(parsed.historyId === undefined ? {} : { historyId: String(parsed.historyId) })
      }
      return snapshot
    })
  )
}

function decodeModifyShape(body: unknown, status: number): Effect.Effect<{ readonly id: string; readonly threadId?: string; readonly labelIds: ReadonlyArray<string> }, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailModifyShape)(body).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail response does not match its contract", status })),
    Effect.map((parsed) => ({
      id: parsed.id,
      ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
      labelIds: (parsed.labelIds ?? []) as ReadonlyArray<string>
    }))
  )
}

function decodeProfileShape(body: unknown, status: number): Effect.Effect<GmailProfile, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailProfileShape)(body).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail response does not match its contract", status })),
    Effect.map((parsed) => ({
      emailAddress: parsed.emailAddress,
      ...(parsed.historyId === undefined ? {} : { historyId: String(parsed.historyId) })
    }))
  )
}

function sendGmailRequest(input: {
  readonly settings: TransportSettings
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: { readonly addLabelIds: ReadonlyArray<string>; readonly removeLabelIds?: ReadonlyArray<string> }
}): Effect.Effect<GmailResponse, GmailTransportError, HttpClient.HttpClient> {
  return Effect.gen(function*() {
    const url = `${input.settings.baseUrl}${input.path}`
    const unauthenticated = input.method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    const authorized = unauthenticated.pipe(
      HttpClientRequest.bearerToken(input.settings.token),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "expand-automation" })
    )
    const requested = input.body === undefined ? authorized : yield* HttpClientRequest.schemaBodyJson(GmailModifyBody)(authorized, {
      addLabelIds: [...input.body.addLabelIds],
      ...(input.body.removeLabelIds === undefined ? {} : { removeLabelIds: [...input.body.removeLabelIds] })
    }).pipe(
      Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail request does not match its contract" }))
    )
    const maybe = yield* HttpClient.execute(requested).pipe(
      Effect.mapError(() => new GmailTransportError({ code: "connection-failed", message: "Gmail request failed" })),
      Effect.timeoutOption(Duration.millis(input.settings.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new GmailTransportError({ code: "connection-failed", message: "Gmail request exceeded its deadline" })
    }
    const response = maybe.value
    const text = yield* response.text.pipe(
      Effect.mapError(() => new GmailTransportError({ code: "connection-failed", message: "Gmail response was unreadable", status: response.status }))
    )
    const body: unknown = text.length === 0 ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail response was not JSON", status: response.status }))
    )
    const now = yield* Clock.currentTimeMillis
    const scopes = parseScopes(response.headers)
    const waited = retryAfterMs(response.headers, now)
    yield* mapGmailStatus(response.status, body, waited)
    return { status: response.status, scopes, retryAfter: waited, body }
  })
}

function headerNumber(headers: Headers.Headers, name: string): number | null {
  const raw = Option.getOrNull(Headers.get(name)(headers))
  if (raw === null || raw.trim() === "") return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function parseScopes(headers: Headers.Headers): ReadonlyArray<string> {
  const raw = Option.getOrNull(Headers.get("x-oauth-scopes")(headers))
  if (raw === null) return []
  return raw.split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0)
}

function retryAfterMs(headers: Headers.Headers, now: number): number | undefined {
  const retryAfter = headerNumber(headers, "retry-after")
  if (retryAfter !== null && retryAfter >= 0) return Math.floor(retryAfter * 1000)
  void now
  return undefined
}

function bodyMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") return body.message
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as Record<string, unknown>)["error"]
    if (typeof error === "object" && error !== null && "message" in error && typeof (error as Record<string, unknown>)["message"] === "string") {
      return (error as Record<string, unknown>)["message"] as string
    }
  }
  return ""
}

function mapGmailStatus(status: number, body: unknown, waited: number | undefined): Effect.Effect<void, GmailTransportError> {
  if (status >= 200 && status < 300) return Effect.void
  if (status === 401 || status === 403) {
    const message = bodyMessage(body)
    if (status === 401 || /insufficient|invalid.*credential|auth/i.test(message)) {
      return Effect.fail(new GmailTransportError({ code: "auth", message: "Gmail rejected the credential", status }))
    }
    if (status === 403) {
      return Effect.fail(new GmailTransportError({ code: "forbidden", message: "Gmail denied the request", status }))
    }
  }
  if (status === 404) {
    return Effect.fail(new GmailTransportError({ code: "not-found", message: "Gmail message was not found", status }))
  }
  if (status === 429) {
    return Effect.fail(new GmailTransportError({
      code: "rate-limited", message: "Gmail rate limit exceeded", status,
      ...(waited === undefined ? {} : { retryAfterMs: waited })
    }))
  }
  if (status >= 500) {
    return Effect.fail(new GmailTransportError({ code: "api-error", message: "Gmail responded with a retryable failure", status }))
  }
  return Effect.fail(new GmailTransportError({ code: "api-error", message: "Gmail responded with an unexpected status", status }))
}
