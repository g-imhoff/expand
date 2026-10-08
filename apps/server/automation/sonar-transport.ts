import { Data, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export class SonarTransportError extends Data.TaggedError("SonarTransportError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}

export interface SonarTransportOptions {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

export interface SonarIssue {
  readonly key: string
  readonly status: string
  readonly severity: string
  readonly rule: string
  readonly message: string
  readonly component?: string
  readonly line?: number
}

export {
  getSonarIssue,
  listSonarIssues,
  verifySonarIssue
}

const SonarDefaultTimeoutMs = 10000
const SonarDefaultMaxRetries = 2

const getSonarIssue = Effect.fn("SonarTransport.getSonarIssue")(function*(
  baseUrl: string,
  issueKey: string,
  token: string,
  options?: SonarTransportOptions
) {
  if (typeof issueKey !== "string" || issueKey.length === 0) {
    return yield* new SonarTransportError({ code: "invalid-contract", message: "SonarQube issue key is not usable" })
  }
  const transport = yield* resolveTransport(baseUrl, options)
  const url = `${transport.baseUrl}/api/issues/search?issues=${encodeURIComponent(issueKey)}`
  const raw = yield* fetchWithRetry({ method: "GET", url, token, transport }, 0)
  const issues = yield* decodeSearch(raw)
  const found = issues.find((entry) => entry.key === issueKey)
  if (found === undefined) {
    return yield* new SonarTransportError({ code: "not-found", message: "SonarQube finding was not found", status: 404 })
  }
  return found
})

const listSonarIssues = Effect.fn("SonarTransport.listSonarIssues")(function*(
  baseUrl: string,
  projectKey: string,
  token: string,
  options?: SonarTransportOptions
) {
  if (typeof projectKey !== "string" || projectKey.length === 0) {
    return yield* new SonarTransportError({ code: "invalid-contract", message: "SonarQube project key is not usable" })
  }
  const transport = yield* resolveTransport(baseUrl, options)
  const url = `${transport.baseUrl}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}&statuses=OPEN,CONFIRMED,REOPENED&ps=100`
  const raw = yield* fetchWithRetry({ method: "GET", url, token, transport }, 0)
  return yield* decodeSearch(raw)
})

const verifySonarIssue = Effect.fn("SonarTransport.verifySonarIssue")(function*(
  baseUrl: string,
  issueKey: string,
  token: string,
  options?: SonarTransportOptions
) {
  const issue = yield* getSonarIssue(baseUrl, issueKey, token, options)
  const resolved = isResolvedStatus(issue.status)
  return { key: issue.key, status: issue.status, resolved }
})

const isResolvedStatus = (status: string): boolean => {
  return status === "CLOSED" || status === "RESOLVED"
}

interface ResolvedTransport {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxRetries: number
}

interface FetchInput {
  readonly method: "GET"
  readonly url: string
  readonly token: string
  readonly transport: ResolvedTransport
}

const SonarIssueResponse = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.String.check(Schema.isMinLength(1)),
  severity: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  component: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number)
})

const SonarSearchResponse = Schema.Struct({
  total: Schema.optional(Schema.Number),
  issues: Schema.optional(Schema.Array(SonarIssueResponse))
})

function decodeSearch(input: unknown): Effect.Effect<ReadonlyArray<SonarIssue>, SonarTransportError> {
  return Schema.decodeUnknownEffect(SonarSearchResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new SonarTransportError({ code: "api", message: "SonarQube returned an unexpected search payload" })),
    Effect.flatMap((response) => {
      const entries = response.issues ?? []
      const out: Array<SonarIssue> = []
      for (const entry of entries) {
        if (entry.key.length === 0 || entry.status.length === 0) {
          return Effect.fail(new SonarTransportError({ code: "api", message: "SonarQube returned an unexpected issue payload" }))
        }
        out.push({
          key: entry.key,
          status: entry.status,
          severity: entry.severity ?? "MAJOR",
          rule: entry.rule ?? "unknown",
          message: entry.message ?? "",
          ...(entry.component === undefined ? {} : { component: entry.component }),
          ...(entry.line === undefined ? {} : { line: entry.line })
        })
      }
      return Effect.succeed(out)
    })
  )
}

function resolveTransport(baseUrl: string, options?: SonarTransportOptions): Effect.Effect<ResolvedTransport, SonarTransportError> {
  return Effect.gen(function*() {
    const candidate = options?.baseUrl ?? baseUrl
    if (typeof candidate !== "string" || candidate.length === 0) {
      return yield* new SonarTransportError({ code: "invalid-contract", message: "SonarQube base URL is not configured" })
    }
    yield* Effect.try({
      try: () => {
        const url = new URL(candidate)
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
        return url
      },
      catch: () => new SonarTransportError({ code: "invalid-contract", message: "SonarQube base URL is not a usable URL" })
    })
    const timeoutMs = options?.timeoutMs ?? SonarDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new SonarTransportError({ code: "invalid-contract", message: "SonarQube timeout is out of range" })
    }
    const maxRetries = options?.maxRetries ?? SonarDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new SonarTransportError({ code: "invalid-contract", message: "SonarQube retry budget is out of range" })
    }
    return { baseUrl: candidate.replace(/\/+$/, ""), timeoutMs, maxRetries }
  })
}

function singleFetch(input: FetchInput): Effect.Effect<unknown, SonarTransportError, HttpClient.HttpClient> {
  return Effect.gen(function*() {
    if (typeof input.token !== "string" || input.token.length === 0) {
      return yield* new SonarTransportError({ code: "auth", message: "SonarQube credential is missing" })
    }
    const outgoing = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeader("Accept", "application/json"),
      HttpClientRequest.setHeader("User-Agent", "expand-automation"),
      HttpClientRequest.bearerToken(input.token)
    )
    const maybe = yield* HttpClient.execute(outgoing).pipe(
      Effect.mapError(() => new SonarTransportError({ code: "connection", message: "SonarQube transport failed" })),
      Effect.timeoutOption(Duration.millis(input.transport.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new SonarTransportError({ code: "connection", message: "SonarQube request exceeded its deadline" })
    }
    const response = maybe.value
    if (response.status === 401) {
      return yield* new SonarTransportError({ code: "auth", message: "SonarQube rejected the credential", status: 401 })
    }
    if (response.status === 403) {
      return yield* new SonarTransportError({ code: "forbidden", message: "SonarQube denied the request", status: 403 })
    }
    if (response.status === 404) {
      return yield* new SonarTransportError({ code: "not-found", message: "SonarQube project or finding was not found", status: 404 })
    }
    if (response.status === 429) {
      return yield* new SonarTransportError({ code: "rate-limited", message: "SonarQube rate limit exceeded", status: 429 })
    }
    if (response.status >= 500) {
      return yield* new SonarTransportError({ code: "api", message: "SonarQube responded with a retryable failure", status: response.status })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new SonarTransportError({ code: "api", message: "SonarQube responded with an unexpected status", status: response.status })
    }
    return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown, { onExcessProperty: "ignore" })(response).pipe(
      Effect.mapError(() => new SonarTransportError({ code: "api", message: "SonarQube response was not usable JSON", status: response.status }))
    )
  })
}

function fetchWithRetry(input: FetchInput, attempt: number): Effect.Effect<unknown, SonarTransportError, HttpClient.HttpClient> {
  return singleFetch(input).pipe(
    Effect.catch((error) =>
      isRetryable(error) && attempt < input.transport.maxRetries
        ? Effect.sleep(backoffDelay(attempt)).pipe(Effect.andThen(() => fetchWithRetry(input, attempt + 1)))
        : Effect.fail(error))
  )
}

function isRetryable(error: SonarTransportError): boolean {
  if (error.code === "rate-limited" || error.code === "connection") return true
  if (error.code !== "api" || error.status === undefined) return false
  return error.status >= 500
}

function backoffDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(250 * 2 ** attempt, 4000))
}
