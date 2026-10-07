import { Data, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
export class GmailTransportError extends Data.TaggedError("GmailTransportError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}
export interface GmailTransportOptions {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
}
export interface GmailMessageId {
  readonly id: string
  readonly threadId: string
}
export interface GmailMessage {
  readonly id: string
  readonly threadId: string
  readonly historyId: string
  readonly labelIds: ReadonlyArray<string>
  readonly from: string
  readonly subject: string
  readonly snippet: string
  readonly body: string
}
export interface GmailModifyResult {
  readonly id: string
  readonly threadId: string
  readonly labelIds: ReadonlyArray<string>
}
export const GmailApiBaseUrl = "https://gmail.googleapis.com"
export const GmailDefaultTimeoutMs = 10000
export const GmailDefaultMaxRetries = 2
export const readMailboxHistoryId = Effect.fn("GmailTransport.readMailboxHistoryId")(function*(
  userId: string,
  token: string,
  options?: GmailTransportOptions
) {
  const transport = yield* resolveTransport(options)
  const user = yield* encodeUser(userId)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}/gmail/v1/users/${user}/profile`, token, transport }, 0)
  const profile = yield* Schema.decodeUnknownEffect(Schema.Struct({ historyId: Schema.String.check(Schema.isMinLength(1)) }), { onExcessProperty: "ignore" })(raw).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail returned an unexpected profile payload" }))
  )
  return profile.historyId
})
export const listMessages = Effect.fn("GmailTransport.listMessages")(function*(
  userId: string,
  token: string,
  options?: GmailTransportOptions
) {
  const transport = yield* resolveTransport(options)
  const user = yield* encodeUser(userId)
  const messages: Array<GmailMessageId> = []
  const seen = new Set<string>()
  let pageToken = ""
  while (true) {
    const suffix = pageToken.length === 0 ? "" : `?pageToken=${encodeURIComponent(pageToken)}`
    const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}/gmail/v1/users/${user}/messages${suffix}`, token, transport }, 0)
    const page = yield* decodeMessageIds(raw)
    messages.push(...page.messages)
    pageToken = page.nextPageToken
    if (pageToken.length === 0) return messages
    if (seen.has(pageToken) || seen.size >= 1000) return yield* new GmailTransportError({ code: "api", message: "Gmail pagination did not complete" })
    seen.add(pageToken)
  }
})
export const listHistory = Effect.fn("GmailTransport.listHistory")(function*(
  userId: string,
  startHistoryId: string,
  token: string,
  options?: GmailTransportOptions
) {
  if (typeof startHistoryId !== "string" || startHistoryId.length === 0) {
    return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail history marker is not usable" })
  }
  const transport = yield* resolveTransport(options)
  const user = yield* encodeUser(userId)
  const added = new Map<string, GmailMessageId>()
  const seen = new Set<string>()
  let pageToken = ""
  while (true) {
    const suffix = pageToken.length === 0 ? "" : `&pageToken=${encodeURIComponent(pageToken)}`
    const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}/gmail/v1/users/${user}/history?startHistoryId=${encodeURIComponent(startHistoryId)}${suffix}`, token, transport }, 0)
    const page = yield* decodeHistory(raw)
    for (const message of page.added) added.set(message.id, message)
    pageToken = page.nextPageToken
    if (pageToken.length === 0) return { historyId: page.historyId, added: [...added.values()] }
    if (seen.has(pageToken) || seen.size >= 1000) return yield* new GmailTransportError({ code: "api", message: "Gmail pagination did not complete" })
    seen.add(pageToken)
  }
})
export const getMessage = Effect.fn("GmailTransport.getMessage")(function*(
  userId: string,
  messageId: string,
  token: string,
  options?: GmailTransportOptions
) {
  if (typeof messageId !== "string" || messageId.length === 0) {
    return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail message reference is not usable" })
  }
  const transport = yield* resolveTransport(options)
  const user = yield* encodeUser(userId)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}/gmail/v1/users/${user}/messages/${encodeURIComponent(messageId)}?format=full`, token, transport }, 0)
  return yield* decodeMessage(raw)
})
export const modifyMessage = Effect.fn("GmailTransport.modifyMessage")(function*(
  userId: string,
  messageId: string,
  changes: { readonly addLabelIds: ReadonlyArray<string>; readonly removeLabelIds: ReadonlyArray<string> },
  token: string,
  options?: GmailTransportOptions
) {
  if (typeof messageId !== "string" || messageId.length === 0) {
    return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail message reference is not usable" })
  }
  const validated = yield* Schema.decodeUnknownEffect(GmailModifyRequest, { onExcessProperty: "error" })({ addLabelIds: [...changes.addLabelIds], removeLabelIds: [...changes.removeLabelIds] }).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail label change is not usable" }))
  )
  const transport = yield* resolveTransport(options)
  const user = yield* encodeUser(userId)
  const raw = yield* fetchWithRetry({ method: "POST", url: `${transport.baseUrl}/gmail/v1/users/${user}/messages/${encodeURIComponent(messageId)}/modify`, token, body: validated, transport }, 0)
  return yield* decodeModify(raw)
})
interface ResolvedTransport {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxRetries: number
}
interface FetchInput {
  readonly method: "GET" | "POST"
  readonly url: string
  readonly token: string
  readonly body?: typeof GmailModifyRequest.Type
  readonly transport: ResolvedTransport
}
const GmailLabelId = Schema.String.check(Schema.isMinLength(1))
const GmailListResponse = Schema.Struct({
  messages: Schema.optional(Schema.Array(Schema.Struct({ id: GmailLabelId, threadId: GmailLabelId }))),
  nextPageToken: Schema.optional(Schema.String),
  resultSizeEstimate: Schema.optional(Schema.Number)
})
const GmailHistoryResponse = Schema.Struct({
  history: Schema.optional(Schema.Array(Schema.Struct({
    messagesAdded: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.Struct({ id: GmailLabelId, threadId: GmailLabelId }) })))
  }))),
  historyId: Schema.String,
  nextPageToken: Schema.optional(Schema.String)
})
const GmailHeader = Schema.Struct({ name: Schema.String, value: Schema.String })
const GmailPayload = Schema.Struct({
  mimeType: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Array(GmailHeader)),
  body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
  parts: Schema.optional(Schema.Array(Schema.Unknown))
})
const GmailGetResponse = Schema.Struct({
  id: GmailLabelId,
  threadId: GmailLabelId,
  historyId: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  snippet: Schema.optional(Schema.String),
  payload: Schema.optional(GmailPayload)
})
const GmailModifyRequest = Schema.Struct({
  addLabelIds: Schema.Array(Schema.String),
  removeLabelIds: Schema.Array(Schema.String)
})
const GmailModifyResponse = Schema.Struct({
  id: GmailLabelId,
  threadId: GmailLabelId,
  labelIds: Schema.optional(Schema.Array(Schema.String))
})
function decodeMessageIds(input: unknown): Effect.Effect<{ readonly messages: ReadonlyArray<GmailMessageId>; readonly nextPageToken: string }, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailListResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail returned an unexpected list payload" })),
    Effect.map((response) => ({ messages: response.messages ?? [], nextPageToken: response.nextPageToken ?? "" }))
  )
}
function decodeHistory(input: unknown): Effect.Effect<{ readonly historyId: string; readonly added: ReadonlyArray<GmailMessageId>; readonly nextPageToken: string }, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailHistoryResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail returned an unexpected history payload" })),
    Effect.flatMap((response) => {
      if (response.historyId.length === 0) return Effect.fail(new GmailTransportError({ code: "api", message: "Gmail returned an unexpected history payload" }))
      const added: Array<GmailMessageId> = []
      for (const entry of response.history ?? []) {
        for (const item of entry.messagesAdded ?? []) {
          added.push({ id: item.message.id, threadId: item.message.threadId })
        }
      }
      return Effect.succeed({ historyId: response.historyId, added, nextPageToken: response.nextPageToken ?? "" })
    })
  )
}
function decodeMessage(input: unknown): Effect.Effect<GmailMessage, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailGetResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail returned an unexpected message payload" })),
    Effect.flatMap(Effect.fn("GmailTransport.decodeMessage")(function*(response) {
      if (response.id.length === 0 || response.threadId.length === 0) {
        return yield* new GmailTransportError({ code: "api", message: "Gmail returned an unexpected message payload" })
      }
      const headers = response.payload?.headers ?? []
      let from = ""
      let subject = ""
      for (const header of headers) {
        const name = header.name.toLowerCase()
        if (name === "from" && from.length === 0) from = header.value
        if (name === "subject" && subject.length === 0) subject = header.value
      }
      const body = response.payload === undefined ? response.snippet ?? "" : yield* decodeMessageBody(response.payload)
      return {
        id: response.id,
        threadId: response.threadId,
        historyId: response.historyId ?? "",
        labelIds: response.labelIds ?? [],
        from,
        subject,
        snippet: response.snippet ?? "",
        body
      }
    }))
  )
}
const decodeMessageBody = Effect.fn("GmailTransport.decodeBody")(function*(payload: typeof GmailPayload.Type) {
  const queue: Array<unknown> = [payload]
  const plain: Array<string> = []
  const html: Array<string> = []
  let count = 0
  while (queue.length > 0) {
    if (++count > 1000) return yield* new GmailTransportError({ code: "api", message: "Gmail message has too many MIME parts" })
    const part = yield* Schema.decodeUnknownEffect(GmailPayload, { onExcessProperty: "ignore" })(queue.shift()).pipe(
      Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail returned an unexpected MIME part" }))
    )
    if ((part.filename ?? "").length > 0) continue
    queue.push(...part.parts ?? [])
    const data = part.body?.data
    if (data === undefined || data.length === 0) continue
    if (part.mimeType !== undefined && part.mimeType !== "text/plain" && part.mimeType !== "text/html") continue
    if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(data)) return yield* new GmailTransportError({ code: "api", message: "Gmail message body is not base64url" })
    const text = Buffer.from(data, "base64url").toString("utf8")
    if (part.mimeType === "text/html") html.push(text)
    else plain.push(text)
  }
  return (plain.length > 0 ? plain : html).join("\n")
})
function decodeModify(input: unknown): Effect.Effect<GmailModifyResult, GmailTransportError> {
  return Schema.decodeUnknownEffect(GmailModifyResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail returned an unexpected modify payload" })),
    Effect.map((response) => ({ id: response.id, threadId: response.threadId, labelIds: response.labelIds ?? [] }))
  )
}
function encodeUser(userId: string): Effect.Effect<string, GmailTransportError> {
  if (typeof userId !== "string" || userId.length === 0) {
    return Effect.fail(new GmailTransportError({ code: "invalid-contract", message: "Gmail mailbox reference is not configured" }))
  }
  return Effect.succeed(encodeURIComponent(userId))
}
function resolveTransport(options?: GmailTransportOptions): Effect.Effect<ResolvedTransport, GmailTransportError> {
  return Effect.gen(function* () {
    const baseUrl = options?.baseUrl ?? GmailApiBaseUrl
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail base URL is not configured" })
    }
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
        return url
      },
      catch: () => new GmailTransportError({ code: "invalid-contract", message: "Gmail base URL is not a usable URL" })
    })
    const timeoutMs = options?.timeoutMs ?? GmailDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail timeout is out of range" })
    }
    const maxRetries = options?.maxRetries ?? GmailDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new GmailTransportError({ code: "invalid-contract", message: "Gmail retry budget is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs, maxRetries }
  })
}
function singleFetch(input: FetchInput): Effect.Effect<unknown, GmailTransportError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (typeof input.token !== "string" || input.token.length === 0) {
      return yield* new GmailTransportError({ code: "auth", message: "Gmail credential is missing" })
    }
    const base = input.method === "GET" ? HttpClientRequest.get(input.url) : HttpClientRequest.post(input.url)
    const withHeaders = base.pipe(
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.setHeader("User-Agent", "expand-automation"),
      HttpClientRequest.bearerToken(input.token)
    )
    const outgoing = input.body === undefined
      ? withHeaders
      : yield* HttpClientRequest.schemaBodyJson(GmailModifyRequest)(withHeaders, input.body).pipe(
        Effect.mapError(() => new GmailTransportError({ code: "invalid-contract", message: "Gmail label change is not usable" }))
      )
    const maybe = yield* HttpClient.execute(outgoing).pipe(
      Effect.mapError(() => new GmailTransportError({ code: "connection", message: "Gmail transport failed" })),
      Effect.timeoutOption(Duration.millis(input.transport.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new GmailTransportError({ code: "connection", message: "Gmail request exceeded its deadline" })
    }
    const response = maybe.value
    if (response.status === 401) {
      return yield* new GmailTransportError({ code: "auth", message: "Gmail rejected the credential", status: 401 })
    }
    if (response.status === 403) {
      return yield* new GmailTransportError({ code: "forbidden", message: "Gmail denied the request", status: 403 })
    }
    if (response.status === 404) {
      return yield* new GmailTransportError({ code: "not-found", message: "Gmail mailbox or message was not found", status: 404 })
    }
    if (response.status === 429) {
      return yield* new GmailTransportError({ code: "rate-limited", message: "Gmail rate limit exceeded", status: 429 })
    }
    if (response.status === 529 || response.status >= 500) {
      return yield* new GmailTransportError({ code: "api", message: "Gmail responded with a retryable failure", status: response.status })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new GmailTransportError({ code: "api", message: "Gmail responded with an unexpected status", status: response.status })
    }
    return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown, { onExcessProperty: "ignore" })(response).pipe(
      Effect.mapError(() => new GmailTransportError({ code: "api", message: "Gmail response was not usable JSON", status: response.status }))
    )
  })
}
function fetchWithRetry(input: FetchInput, attempt: number): Effect.Effect<unknown, GmailTransportError, HttpClient.HttpClient> {
  return singleFetch(input).pipe(
    Effect.catch((error) =>
      isRetryable(error) && attempt < input.transport.maxRetries
        ? Effect.sleep(backoffDelay(attempt)).pipe(Effect.andThen(() => fetchWithRetry(input, attempt + 1)))
        : Effect.fail(error))
  )
}
function isRetryable(error: GmailTransportError): boolean {
  if (error.code === "rate-limited" || error.code === "connection") return true
  if (error.code !== "api" || error.status === undefined) return false
  return error.status === 529 || error.status >= 500
}
function backoffDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(250 * 2 ** attempt, 4000))
}
