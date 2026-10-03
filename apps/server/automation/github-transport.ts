import { Clock, Data, Duration, Effect, Option, Schema } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"

export class GithubTransportError extends Data.TaggedError("GithubTransportError")<{
  readonly code: "connection-failed" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api-error" | "invalid-contract"
  readonly message: string
  readonly status?: number
  readonly retryAfterMs?: number
}> {}

export interface GithubIssueSnapshot {
  readonly title: string
  readonly body?: string
  readonly labels: ReadonlyArray<string>
}

export interface GithubRateMeta {
  readonly scopes: ReadonlyArray<string>
  readonly rateLimit?: {
    readonly limit: number
    readonly remaining: number
    readonly reset: number
  }
}

export const GithubApiBaseUrl = "https://api.github.com"
export const GithubDefaultTimeoutMs = 10000
export const GithubMaxLabelPages = 10

export const getRepositoryLabels = Effect.fn("GithubTransport.getRepositoryLabels")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly owner: unknown; readonly repo: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const owner = yield* decodeSegment(input.owner)
  const repo = yield* decodeSegment(input.repo)
  const names: Array<string> = []
  let path: string | null = `/repos/${owner}/${repo}/labels?per_page=100`
  for (let page = 0; page < GithubMaxLabelPages && path !== null; page += 1) {
    const response = yield* sendGithubRequest({ settings, method: "GET", path })
    const parsed = yield* decodeLabelList(response.body, response.status)
    for (const label of parsed) names.push(label.name)
    path = nextGithubPath(settings.baseUrl, response.link)
  }
  return names as ReadonlyArray<string>
})

export const readIssue = Effect.fn("GithubTransport.readIssue")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly owner: unknown; readonly repo: unknown; readonly issueNumber: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const owner = yield* decodeSegment(input.owner)
  const repo = yield* decodeSegment(input.repo)
  const issueNumber = yield* decodeIssueNumber(input.issueNumber)
  const response = yield* sendGithubRequest({ settings, method: "GET", path: `/repos/${owner}/${repo}/issues/${issueNumber}` })
  const parsed = yield* decodeIssueShape(response.body, response.status)
  const labels: Array<string> = []
  for (const label of parsed.labels) labels.push(typeof label === "string" ? label : label.name)
  const snapshot: GithubIssueSnapshot = {
    title: parsed.title,
    ...(parsed.body === undefined || parsed.body === null ? {} : { body: parsed.body }),
    labels
  }
  return snapshot
})

export const writeIssueLabels = Effect.fn("GithubTransport.writeIssueLabels")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly owner: unknown; readonly repo: unknown; readonly issueNumber: unknown; readonly labels: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const owner = yield* decodeSegment(input.owner)
  const repo = yield* decodeSegment(input.repo)
  const issueNumber = yield* decodeIssueNumber(input.issueNumber)
  const labels = yield* decodeGithubLabels(input.labels)
  const response = yield* sendGithubRequest({
    settings, method: "PATCH", path: `/repos/${owner}/${repo}/issues/${issueNumber}`, body: { labels: [...labels] }
  })
  const parsed = yield* decodeIssueShape(response.body, response.status)
  return parsed.labels.map((label) => typeof label === "string" ? label : label.name) as ReadonlyArray<string>
})

export const readRateLimit = Effect.fn("GithubTransport.readRateLimit")(function*(
  input: { readonly baseUrl: unknown; readonly token: unknown; readonly timeoutMs?: number }
) {
  const settings = yield* resolveTransportSettings(input)
  const response = yield* sendGithubRequest({ settings, method: "GET", path: "/rate_limit" })
  return response.meta
})

interface TransportSettings {
  readonly baseUrl: string
  readonly token: string
  readonly timeoutMs: number
}

interface GithubResponse {
  readonly status: number
  readonly meta: GithubRateMeta
  readonly link: string | null
  readonly body: unknown
}

const GithubLabelList = Schema.Array(Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }))
const GithubIssueShape = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  labels: Schema.Array(Schema.Union([Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }), Schema.String]))
})
const GithubWriteBody = Schema.Struct({ labels: Schema.Array(Schema.String.check(Schema.isMinLength(1))) })
const GithubSegment = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100), Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u))

function resolveTransportSettings(input: {
  readonly baseUrl: unknown
  readonly token: unknown
  readonly timeoutMs?: number
}): Effect.Effect<TransportSettings, GithubTransportError> {
  return Effect.gen(function*() {
    const baseUrl = input.baseUrl
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub endpoint is not configured" })
    }
    const origin = yield* Effect.try({
      try: () => new URL(baseUrl),
      catch: () => new GithubTransportError({ code: "invalid-contract", message: "GitHub endpoint is not a usable URL" })
    })
    if (origin.protocol !== "https:" && origin.protocol !== "http:") {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub endpoint is not a usable URL" })
    }
    const token = input.token
    if (typeof token !== "string" || token.length === 0) {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub token is not usable" })
    }
    const timeoutMs = input.timeoutMs ?? GithubDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub timeout is out of range" })
    }
    return { baseUrl: origin.toString().replace(/\/+$/u, ""), token, timeoutMs }
  })
}

function decodeSegment(value: unknown): Effect.Effect<string, GithubTransportError> {
  return Schema.decodeUnknownEffect(GithubSegment)(value).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub repository reference is not usable" }))
  )
}

function decodeIssueNumber(value: unknown): Effect.Effect<number, GithubTransportError> {
  return Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))(value).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub issue number is not usable" }))
  )
}

function decodeGithubLabels(value: unknown): Effect.Effect<ReadonlyArray<string>, GithubTransportError> {
  return Schema.decodeUnknownEffect(Schema.Array(Schema.String.check(Schema.isMinLength(1))))(value).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub labels are not usable" }))
  )
}

function decodeLabelList(body: unknown, status: number): Effect.Effect<ReadonlyArray<{ readonly name: string }>, GithubTransportError> {
  return Schema.decodeUnknownEffect(GithubLabelList)(body).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub response does not match its contract", status }))
  )
}

function decodeIssueShape(body: unknown, status: number): Effect.Effect<typeof GithubIssueShape.Type, GithubTransportError> {
  return Schema.decodeUnknownEffect(GithubIssueShape)(body).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub response does not match its contract", status }))
  )
}

function sendGithubRequest(input: {
  readonly settings: TransportSettings
  readonly method: "GET" | "PATCH"
  readonly path: string
  readonly body?: { readonly labels: ReadonlyArray<string> }
}): Effect.Effect<GithubResponse, GithubTransportError, HttpClient.HttpClient> {
  return Effect.gen(function*() {
    const url = `${input.settings.baseUrl}${input.path}`
    const unauthenticated = input.method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.patch(url)
    const authorized = unauthenticated.pipe(
      HttpClientRequest.bearerToken(input.settings.token),
      HttpClientRequest.setHeaders({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "expand-automation" })
    )
    const requested = input.body === undefined ? authorized : yield* HttpClientRequest.schemaBodyJson(GithubWriteBody)(authorized, { labels: [...input.body.labels] }).pipe(
      Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub request does not match its contract" }))
    )
    const maybe = yield* HttpClient.execute(requested).pipe(
      Effect.mapError(() => new GithubTransportError({ code: "connection-failed", message: "GitHub request failed" })),
      Effect.timeoutOption(Duration.millis(input.settings.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new GithubTransportError({ code: "connection-failed", message: "GitHub request exceeded its deadline" })
    }
    const response = maybe.value
    const text = yield* response.text.pipe(
      Effect.mapError(() => new GithubTransportError({ code: "connection-failed", message: "GitHub response was unreadable", status: response.status }))
    )
    const body: unknown = text.length === 0 ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub response was not JSON", status: response.status }))
    )
    const now = yield* Clock.currentTimeMillis
    const meta = parseGithubMeta(response.headers)
    const waited = retryAfterMs(response.headers, now)
    yield* mapGithubStatus(response.status, body, meta, waited)
    return { status: response.status, meta, link: Option.getOrNull(Headers.get("link")(response.headers)), body }
  })
}

function headerNumber(headers: Headers.Headers, name: string): number | null {
  const raw = Option.getOrNull(Headers.get(name)(headers))
  if (raw === null || raw.trim() === "") return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function parseGithubMeta(headers: Headers.Headers): GithubRateMeta {
  const scopes = Option.getOrElse(Headers.get("x-oauth-scopes")(headers), () => "").split(",").map((scope) => scope.trim()).filter((scope) => scope.length > 0)
  const limit = headerNumber(headers, "x-ratelimit-limit")
  const remaining = headerNumber(headers, "x-ratelimit-remaining")
  const reset = headerNumber(headers, "x-ratelimit-reset")
  const meta: GithubRateMeta = { scopes: scopes as ReadonlyArray<string> }
  if (limit !== null && remaining !== null && reset !== null && Number.isSafeInteger(limit) && Number.isSafeInteger(remaining) && Number.isSafeInteger(reset)) {
    return { ...meta, rateLimit: { limit, remaining, reset } }
  }
  return meta
}

function retryAfterMs(headers: Headers.Headers, now: number): number | undefined {
  const retryAfter = headerNumber(headers, "retry-after")
  if (retryAfter !== null && retryAfter >= 0) return Math.floor(retryAfter * 1000)
  const remaining = headerNumber(headers, "x-ratelimit-remaining")
  const reset = headerNumber(headers, "x-ratelimit-reset")
  if (remaining === 0 && reset !== null && Number.isSafeInteger(reset)) return Math.max(0, reset * 1000 - now)
  return undefined
}

function bodyMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") return body.message
  return ""
}

function mapGithubStatus(status: number, body: unknown, meta: GithubRateMeta, waited: number | undefined): Effect.Effect<void, GithubTransportError> {
  if (status >= 200 && status < 300) return Effect.void
  if (status === 401) {
    return Effect.fail(new GithubTransportError({ code: "auth", message: "GitHub rejected the token", status }))
  }
  if (status === 404) {
    return Effect.fail(new GithubTransportError({ code: "not-found", message: "GitHub repository or issue was not found", status }))
  }
  if (status === 429) {
    return Effect.fail(new GithubTransportError({
      code: "rate-limited", message: "GitHub rate limit exceeded", status,
      ...(waited === undefined ? {} : { retryAfterMs: waited })
    }))
  }
  if (status === 403) {
    if (waited !== undefined || /rate limit/iu.test(bodyMessage(body))) {
      return Effect.fail(new GithubTransportError({
        code: "rate-limited", message: "GitHub rate limit exceeded", status,
        ...(waited === undefined ? {} : { retryAfterMs: waited })
      }))
    }
    return Effect.fail(new GithubTransportError({ code: "forbidden", message: "GitHub denied the request", status }))
  }
  if (status >= 500) {
    return Effect.fail(new GithubTransportError({ code: "api-error", message: "GitHub responded with a retryable failure", status }))
  }
  return Effect.fail(new GithubTransportError({ code: "api-error", message: "GitHub responded with an unexpected status", status }))
}

function nextGithubPath(baseUrl: string, link: string | null): string | null {
  if (link === null) return null
  for (const entry of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(entry.trim())
    if (match?.[1] !== undefined && match[1].startsWith(baseUrl)) return match[1].slice(baseUrl.length)
  }
  return null
}
