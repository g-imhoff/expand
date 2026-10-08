import { Data, Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export class GithubTransportError extends Data.TaggedError("GithubTransportError")<{
  readonly code: "connection" | "auth" | "forbidden" | "not-found" | "rate-limited" | "api" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}

export interface GithubTransportOptions {
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly maxRetries?: number
}

export interface GithubIssue {
  readonly number: number
  readonly title: string
  readonly body?: string
  readonly labels: ReadonlyArray<string>
}

export interface GithubWorkflowRun {
  readonly id: number
  readonly headBranch: string
  readonly headSha: string
  readonly conclusion: string | null
  readonly workflowName: string
  readonly htmlUrl?: string
}

export {
  listRepositoryLabels,
  listIssueLabels,
  getIssue,
  addIssueLabels,
  getWorkflowRun,
  fetchWorkflowRunLogs
}

const GithubApiBaseUrl = "https://api.github.com"
const GithubDefaultTimeoutMs = 10000
const GithubDefaultMaxRetries = 2

const listRepositoryLabels = Effect.fn("GithubTransport.listRepositoryLabels")(function*(
  owner: string,
  repo: string,
  token: string,
  options?: GithubTransportOptions
) {
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/labels?per_page=100`, token, transport }, 0)
  return yield* decodeLabelNames(raw)
})

const listIssueLabels = Effect.fn("GithubTransport.listIssueLabels")(function*(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  options?: GithubTransportOptions
) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub issue number is out of range" })
  }
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/issues/${issueNumber}/labels?per_page=100`, token, transport }, 0)
  return yield* decodeLabelNames(raw)
})

const getIssue = Effect.fn("GithubTransport.getIssue")(function*(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  options?: GithubTransportOptions
) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub issue number is out of range" })
  }
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/issues/${issueNumber}`, token, transport }, 0)
  return yield* decodeIssue(raw)
})

const addIssueLabels = Effect.fn("GithubTransport.addIssueLabels")(function*(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: ReadonlyArray<string>,
  token: string,
  options?: GithubTransportOptions
) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub issue number is out of range" })
  }
  if (labels.length === 0 || labels.some((label) => typeof label !== "string" || label.length === 0)) {
    return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub label list is not usable" })
  }
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const validated = yield* Schema.decodeUnknownEffect(GithubWriteLabelsRequest, { onExcessProperty: "error" })({ labels: [...labels] }).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub label list is not usable" }))
  )
  const raw = yield* fetchWithRetry({ method: "POST", url: `${transport.baseUrl}${path}/issues/${issueNumber}/labels`, token, body: validated, transport }, 0)
  return yield* decodeLabelNames(raw)
})

const getWorkflowRun = Effect.fn("GithubTransport.getWorkflowRun")(function*(
  owner: string,
  repo: string,
  runId: number,
  token: string,
  options?: GithubTransportOptions
) {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub workflow run id is out of range" })
  }
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  const raw = yield* fetchWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/actions/runs/${runId}`, token, transport }, 0)
  return yield* decodeWorkflowRun(raw)
})

const fetchWorkflowRunLogs = Effect.fn("GithubTransport.fetchWorkflowRunLogs")(function*(
  owner: string,
  repo: string,
  runId: number,
  token: string,
  options?: GithubTransportOptions
) {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub workflow run id is out of range" })
  }
  const transport = yield* resolveTransport(options)
  const path = yield* repoPath(owner, repo)
  return yield* fetchTextWithRetry({ method: "GET", url: `${transport.baseUrl}${path}/actions/runs/${runId}/logs`, token, transport }, 0)
})

interface ResolvedTransport {
  readonly baseUrl: string
  readonly timeoutMs: number
  readonly maxRetries: number
}

interface FetchInput {
  readonly method: "GET" | "POST" | "PUT"
  readonly url: string
  readonly token: string
  readonly body?: typeof GithubWriteLabelsRequest.Type
  readonly transport: ResolvedTransport
}

const GithubLabelName = Schema.String.check(Schema.isMinLength(1))
const GithubLabelItem = Schema.Union([GithubLabelName, Schema.Struct({ name: GithubLabelName })])
const GithubLabelsResponse = Schema.Array(GithubLabelItem)
const GithubIssueResponse = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  labels: Schema.Array(GithubLabelItem)
})
const GithubWriteLabelsRequest = Schema.Struct({ labels: Schema.Array(GithubLabelName).check(Schema.isMinLength(1)) })

function labelToName(item: typeof GithubLabelItem.Type): string {
  return typeof item === "string" ? item : item.name
}

function decodeLabelNames(input: unknown): Effect.Effect<ReadonlyArray<string>, GithubTransportError> {
  return Schema.decodeUnknownEffect(GithubLabelsResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "api", message: "GitHub returned an unexpected label payload" })),
    Effect.map((items) => items.map(labelToName))
  )
}

function decodeIssue(input: unknown): Effect.Effect<GithubIssue, GithubTransportError> {
  return Schema.decodeUnknownEffect(GithubIssueResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "api", message: "GitHub returned an unexpected issue payload" })),
    Effect.flatMap((issue) =>
      issue.number > 0 && Number.isSafeInteger(issue.number) && issue.title.length > 0
        ? Effect.succeed({
          number: issue.number,
          title: issue.title,
          ...(issue.body === undefined || issue.body === null ? {} : { body: issue.body }),
          labels: issue.labels.map(labelToName)
        })
        : Effect.fail(new GithubTransportError({ code: "api", message: "GitHub returned an unexpected issue payload" }))
    )
  )
}

function resolveTransport(options?: GithubTransportOptions): Effect.Effect<ResolvedTransport, GithubTransportError> {
  return Effect.gen(function* () {
    const baseUrl = options?.baseUrl ?? GithubApiBaseUrl
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub base URL is not configured" })
    }
    yield* Effect.try({
      try: () => {
        const url = new URL(baseUrl)
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol")
        return url
      },
      catch: () => new GithubTransportError({ code: "invalid-contract", message: "GitHub base URL is not a usable URL" })
    })
    const timeoutMs = options?.timeoutMs ?? GithubDefaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub timeout is out of range" })
    }
    const maxRetries = options?.maxRetries ?? GithubDefaultMaxRetries
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      return yield* new GithubTransportError({ code: "invalid-contract", message: "GitHub retry budget is out of range" })
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutMs, maxRetries }
  })
}

function repoPath(owner: string, repo: string): Effect.Effect<string, GithubTransportError> {
  if (typeof owner !== "string" || owner.length === 0 || typeof repo !== "string" || repo.length === 0) {
    return Effect.fail(new GithubTransportError({ code: "invalid-contract", message: "GitHub repository reference is not configured" }))
  }
  return Effect.succeed(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
}

function singleFetch(input: FetchInput): Effect.Effect<unknown, GithubTransportError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (typeof input.token !== "string" || input.token.length === 0) {
      return yield* new GithubTransportError({ code: "auth", message: "GitHub credential is missing" })
    }
    const base = input.method === "GET"
      ? HttpClientRequest.get(input.url)
      : input.method === "POST"
        ? HttpClientRequest.post(input.url)
        : HttpClientRequest.put(input.url)
    const withHeaders = base.pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
      HttpClientRequest.setHeader("User-Agent", "expand-automation"),
      HttpClientRequest.bearerToken(input.token)
    )
    const outgoing = input.body === undefined
      ? withHeaders
      : yield* HttpClientRequest.schemaBodyJson(GithubWriteLabelsRequest)(withHeaders, input.body).pipe(
        Effect.mapError(() => new GithubTransportError({ code: "invalid-contract", message: "GitHub label payload is not usable" }))
      )
    const maybe = yield* HttpClient.execute(outgoing).pipe(
      Effect.mapError(() => new GithubTransportError({ code: "connection", message: "GitHub transport failed" })),
      Effect.timeoutOption(Duration.millis(input.transport.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new GithubTransportError({ code: "connection", message: "GitHub request exceeded its deadline" })
    }
    const response = maybe.value
    if (response.status === 401) {
      return yield* new GithubTransportError({ code: "auth", message: "GitHub rejected the credential", status: 401 })
    }
    if (response.status === 403) {
      return yield* new GithubTransportError({ code: "forbidden", message: "GitHub denied the request", status: 403 })
    }
    if (response.status === 404) {
      return yield* new GithubTransportError({ code: "not-found", message: "GitHub repository or issue was not found", status: 404 })
    }
    if (response.status === 429) {
      return yield* new GithubTransportError({ code: "rate-limited", message: "GitHub rate limit exceeded", status: 429 })
    }
    if (response.status === 529 || response.status >= 500) {
      return yield* new GithubTransportError({ code: "api", message: "GitHub responded with a retryable failure", status: response.status })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new GithubTransportError({ code: "api", message: "GitHub responded with an unexpected status", status: response.status })
    }
    return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown, { onExcessProperty: "ignore" })(response).pipe(
      Effect.mapError(() => new GithubTransportError({ code: "api", message: "GitHub response was not usable JSON", status: response.status }))
    )
  })
}

function fetchWithRetry(input: FetchInput, attempt: number): Effect.Effect<unknown, GithubTransportError, HttpClient.HttpClient> {
  return singleFetch(input).pipe(
    Effect.catch((error) =>
      isRetryable(error) && attempt < input.transport.maxRetries
        ? Effect.sleep(backoffDelay(attempt)).pipe(Effect.andThen(() => fetchWithRetry(input, attempt + 1)))
        : Effect.fail(error))
  )
}

function isRetryable(error: GithubTransportError): boolean {
  if (error.code === "rate-limited" || error.code === "connection") return true
  if (error.code !== "api" || error.status === undefined) return false
  return error.status === 529 || error.status >= 500
}

function backoffDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(250 * 2 ** attempt, 4000))
}

const GithubWorkflowRunResponse = Schema.Struct({
  id: Schema.Number,
  head_branch: Schema.String,
  head_sha: Schema.String,
  conclusion: Schema.Union([Schema.String, Schema.Null]),
  name: Schema.Union([Schema.String, Schema.Null]),
  html_url: Schema.optional(Schema.Union([Schema.String, Schema.Null]))
})

function decodeWorkflowRun(input: unknown): Effect.Effect<GithubWorkflowRun, GithubTransportError> {
  return Schema.decodeUnknownEffect(GithubWorkflowRunResponse, { onExcessProperty: "ignore" })(input).pipe(
    Effect.mapError(() => new GithubTransportError({ code: "api", message: "GitHub returned an unexpected workflow payload" })),
    Effect.flatMap((run) =>
      Number.isSafeInteger(run.id) && run.id > 0 && run.head_branch.length > 0 && run.head_sha.length > 0
        ? Effect.succeed({
          id: run.id,
          headBranch: run.head_branch,
          headSha: run.head_sha,
          conclusion: run.conclusion,
          workflowName: typeof run.name === "string" && run.name.length > 0 ? run.name : "workflow",
          ...(typeof run.html_url === "string" && run.html_url.length > 0 ? { htmlUrl: run.html_url } : {})
        })
        : Effect.fail(new GithubTransportError({ code: "api", message: "GitHub returned an unexpected workflow payload" }))
    )
  )
}

function singleFetchText(input: FetchInput): Effect.Effect<string, GithubTransportError, HttpClient.HttpClient> {
  return Effect.gen(function*() {
    if (typeof input.token !== "string" || input.token.length === 0) {
      return yield* new GithubTransportError({ code: "auth", message: "GitHub credential is missing" })
    }
    const outgoing = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
      HttpClientRequest.setHeader("User-Agent", "expand-automation"),
      HttpClientRequest.bearerToken(input.token)
    )
    const maybe = yield* HttpClient.execute(outgoing).pipe(
      Effect.mapError(() => new GithubTransportError({ code: "connection", message: "GitHub transport failed" })),
      Effect.timeoutOption(Duration.millis(input.transport.timeoutMs))
    )
    if (Option.isNone(maybe)) {
      return yield* new GithubTransportError({ code: "connection", message: "GitHub request exceeded its deadline" })
    }
    const response = maybe.value
    if (response.status === 401) {
      return yield* new GithubTransportError({ code: "auth", message: "GitHub rejected the credential", status: 401 })
    }
    if (response.status === 403) {
      return yield* new GithubTransportError({ code: "forbidden", message: "GitHub denied the request", status: 403 })
    }
    if (response.status === 404) {
      return yield* new GithubTransportError({ code: "not-found", message: "GitHub workflow run was not found", status: 404 })
    }
    if (response.status === 429) {
      return yield* new GithubTransportError({ code: "rate-limited", message: "GitHub rate limit exceeded", status: 429 })
    }
    if (response.status === 529 || response.status >= 500) {
      return yield* new GithubTransportError({ code: "api", message: "GitHub responded with a retryable failure", status: response.status })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new GithubTransportError({ code: "api", message: "GitHub responded with an unexpected status", status: response.status })
    }
    const text: string = yield* response.text.pipe(
      Effect.mapError(() => new GithubTransportError({ code: "api", message: "GitHub log response was not usable text", status: response.status }))
    )
    if (text.length === 0) {
      return yield* new GithubTransportError({ code: "api", message: "GitHub returned empty logs" })
    }
    return text.slice(0, 4000)
  })
}

function fetchTextWithRetry(input: FetchInput, attempt: number): Effect.Effect<string, GithubTransportError, HttpClient.HttpClient> {
  return singleFetchText(input).pipe(
    Effect.catch((error: GithubTransportError) =>
      isRetryable(error) && attempt < input.transport.maxRetries
        ? Effect.sleep(backoffDelay(attempt)).pipe(Effect.andThen(() => fetchTextWithRetry(input, attempt + 1)))
        : Effect.fail(error))
  )
}
