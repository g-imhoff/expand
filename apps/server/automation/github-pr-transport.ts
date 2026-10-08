import { Data, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export interface GithubPrTransportOptions {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

export interface GithubPullRequest {
  readonly number: number
  readonly title: string
  readonly headBranch: string
  readonly baseBranch: string
  readonly headSha: string
  readonly mergeable: boolean | null
  readonly mergeableState: string | null
}

export {
  getPullRequest,
  listOpenPulls
}

class GithubPrTransportError extends Data.TaggedError("GithubPrTransportError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}

const GithubPrApiBaseUrl = "https://api.github.com"
const GithubPrDefaultTimeoutMs = 10000
const GithubPrDefaultMaxRetries = 2
const GithubPrListLimit = 30

const getPullRequest = Effect.fn("GithubPrTransport.getPullRequest")(function*(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
  options?: GithubPrTransportOptions
) {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    return yield* new GithubPrTransportError({ code: "invalid-contract", message: "GitHub pull number is out of range" })
  }
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/pulls/${pullNumber}`, token, transport }, 0)
  return yield* decodePull(raw)
})

const listOpenPulls = Effect.fn("GithubPrTransport.listOpenPulls")(function*(
  owner: string,
  repo: string,
  token: string,
  options?: GithubPrTransportOptions
) {
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/pulls?state=open&per_page=${GithubPrListLimit}`, token, transport }, 0)
  return yield* decodePullList(raw)
})

interface ResolvedTransport {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxRetries: number
}

interface FetchInput {
  readonly method: "GET" | "PUT"
  readonly url: string
  readonly token: string
  readonly body?: typeof GithubUpdateBranchRequest.Type
  readonly transport: ResolvedTransport
}

const GithubBranchRef = Schema.Struct({
  label: Schema.optional(Schema.String),
  ref: Schema.String.check(Schema.isMinLength(1)),
  sha: Schema.String.check(Schema.isMinLength(1))
})
const GithubPullResponse = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  head: GithubBranchRef,
  base: GithubBranchRef,
  mergeable: Schema.Union([Schema.Boolean, Schema.Null]),
  mergeable_state: Schema.optional(Schema.Union([Schema.String, Schema.Null]))
})
const GithubPullListResponse = Schema.Array(GithubPullResponse)
const GithubUpdateBranchRequest = Schema.Struct({ expected_head_sha: Schema.String.check(Schema.isMinLength(1)) })

function decodePull(input: unknown): Effect.Effect<GithubPullRequest, GithubPrTransportError> {
  return Schema.decodeUnknownEffect(GithubPullResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GithubPrTransportError({ code: "api", message: "GitHub returned an unexpected pull payload" })),
    Effect.flatMap((pull) =>
      pull.number > 0 && Number.isSafeInteger(pull.number) && pull.title.length > 0
        ? Effect.succeed({
          number: pull.number,
          title: pull.title,
          headBranch: pull.head.ref,
          baseBranch: pull.base.ref,
          headSha: pull.head.sha,
          mergeable: pull.mergeable,
          mergeableState: pull.mergeable_state ?? null
        })
        : Effect.fail(new GithubPrTransportError({ code: "api", message: "GitHub returned an unexpected pull payload" }))
    )
  )
}

function decodePullList(input: unknown): Effect.Effect<ReadonlyArray<GithubPullRequest>, GithubPrTransportError> {
  return Schema.decodeUnknownEffect(GithubPullListResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GithubPrTransportError({ code: "api", message: "GitHub returned an unexpected pull list" })),
    Effect.flatMap((pulls) => {
      if (pulls.length > GithubPrListLimit) {
        return Effect.fail(new GithubPrTransportError({ code: "api", message: "GitHub pull list exceeds bounded limit" }))
      }
      return Effect.forEach(pulls, decodePull)
    })
  )
}

function resolveTransport(options?: GithubPrTransportOptions): Effect.Effect<ResolvedTransport, GithubPrTransportError> {
  return Effect.gen(function* () {
    const baseUrl = options?.baseUrl ?? GithubPrApiBaseUrl
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return yield* new GithubPrTransportError({ code: "invalid-contract", message: "GitHub base URL is not configured" })
    }
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
        return url
      },
      catch: () => new GithubPrTransportError({ code: "invalid-contract", message: "GitHub base URL is not a usable URL" })
    })
    const timeoutMs = options?.timeoutMs ?? GithubPrDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GithubPrTransportError({ code: "invalid-contract", message: "GitHub timeout is out of range" })
    }
    const maxRetries = options?.maxRetries ?? GithubPrDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new GithubPrTransportError({ code: "invalid-contract", message: "GitHub retry budget is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs, maxRetries }
  })
}

function repoPath(owner: string, repo: string): Effect.Effect<string, GithubPrTransportError> {
  if (typeof owner !== "string" || owner.length === 0 || typeof repo !== "string" || repo.length === 0) {
    return Effect.fail(new GithubPrTransportError({ code: "invalid-contract", message: "GitHub repository reference is not configured" }))
  }
  return Effect.succeed(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
}

function singleFetch(input: FetchInput): Effect.Effect<unknown, GithubPrTransportError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (typeof input.token !== "string" || input.token.length === 0) {
      return yield* new GithubPrTransportError({ code: "auth", message: "GitHub credential is missing" })
    }
    const base = input.method === "GET" ? HttpClientRequest.get(input.url) : HttpClientRequest.put(input.url)
    const withHeaders = base.pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
      HttpClientRequest.setHeader("User-Agent", "expand-automation"),
      HttpClientRequest.bearerToken(input.token)
    )
    const outgoing = input.body === undefined
      ? withHeaders
      : yield* HttpClientRequest.schemaBodyJson(GithubUpdateBranchRequest)(withHeaders, input.body).pipe(
        Effect.mapError(() => new GithubPrTransportError({ code: "invalid-contract", message: "GitHub update payload is not usable" }))
      )
    const maybe = yield* HttpClient.execute(outgoing).pipe(
      Effect.mapError(() => new GithubPrTransportError({ code: "connection", message: "GitHub transport failed" })),
      Effect.timeoutOption(Duration.millis(input.transport.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new GithubPrTransportError({ code: "connection", message: "GitHub request exceeded its deadline" })
    }
    const response = maybe.value
    if (response.status === 401) {
      return yield* new GithubPrTransportError({ code: "auth", message: "GitHub rejected the credential", status: 401 })
    }
    if (response.status === 403) {
      return yield* new GithubPrTransportError({ code: "forbidden", message: "GitHub denied the request", status: 403 })
    }
    if (response.status === 404) {
      return yield* new GithubPrTransportError({ code: "not-found", message: "GitHub repository or pull was not found", status: 404 })
    }
    if (response.status === 429) {
      return yield* new GithubPrTransportError({ code: "rate-limited", message: "GitHub rate limit exceeded", status: 429 })
    }
    if (response.status === 529 || response.status >= 500) {
      return yield* new GithubPrTransportError({ code: "api", message: "GitHub responded with a retryable failure", status: response.status })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new GithubPrTransportError({ code: "api", message: "GitHub responded with an unexpected status", status: response.status })
    }
    return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown, { onExcessProperty: "ignore" })(response).pipe(
      Effect.mapError(() => new GithubPrTransportError({ code: "api", message: "GitHub response was not usable JSON", status: response.status }))
    )
  })
}

function fetchWithRetry(input: FetchInput, attempt: number): Effect.Effect<unknown, GithubPrTransportError, HttpClient.HttpClient> {
  return singleFetch(input).pipe(
    Effect.catch((error) =>
      isRetryable(error) && attempt < input.transport.maxRetries
        ? Effect.sleep(backoffDelay(attempt)).pipe(Effect.andThen(() => fetchWithRetry(input, attempt + 1)))
        : Effect.fail(error))
  )
}

function isRetryable(error: GithubPrTransportError): boolean {
  if (error.code === "rate-limited" || error.code === "connection") return true
  if (error.code !== "api" || error.status === undefined) return false
  return error.status === 529 || error.status >= 500
}

function backoffDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(250 * 2 ** attempt, 4000))
}
