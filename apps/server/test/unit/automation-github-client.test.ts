import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Clock, Effect, Schema } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { applyGithubLabels, checkGithubStatus, listGithubLabels, readGithubIssue, unionLabels } from "../../automation/github-client.js"
import { getRepositoryLabels, readIssue, readRateLimit, writeIssueLabels } from "../../automation/github-transport.js"
import { githubIssueBody, githubLabelsBody, githubRateLimitBody, startGithubStub } from "../fixtures/automation-github-stub.js"

const fakeToken = "stub-github-token-for-tests-only"
const repository = { owner: "octo", repo: "hello" }
const optionsFor = (baseUrl: string) => ({ baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] })
const withStub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const Http = NodeHttpClient.layerFetch

describe("github label union", () => {
  it.effect("preserves existing labels while appending configured ones", () =>
    Effect.sync(() => {
      expect(unionLabels(["existing"], ["type: bug"])).toEqual(["existing", "type: bug"])
      expect(unionLabels(["one", "two"], ["two", "three"])).toEqual(["one", "two", "three"])
    }))
  it.effect("repeats safely without growing or shrinking the set", () =>
    Effect.sync(() => {
      const once = unionLabels(["existing"], ["type: bug"])
      expect(unionLabels(once, ["type: bug"])).toEqual(once)
      expect(unionLabels(unionLabels([], ["type: bug"]), ["type: bug"])).toEqual(["type: bug"])
    }))
  it.effect("treats names case-insensitively and keeps existing order", () =>
    Effect.sync(() => {
      expect(unionLabels(["Bug"], ["bug"])).toEqual(["Bug"])
      expect(unionLabels(["b", "a"], ["A", "", "c", "c"])).toEqual(["b", "a", "c"])
    }))
})

describe("github transport errors", () => {
  it.live("maps authentication failures without retry and without leaking the token", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 401, body: { message: "Bad credentials" } }))
    const error = yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository }))
    expect(error.code).toBe("auth")
    expect(error.status).toBe(401)
    expect(error.message).not.toContain(fakeToken)
    expect(encode(error)).not.toContain(fakeToken)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.authorization).toBe(`Bearer ${fakeToken}`)
  }).pipe(Effect.provide(Http)))
  it.live("maps forbidden missing and unexpected failures distinctly", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 403, body: { message: "Must have push access" } }))
    expect((yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository }))).code).toBe("forbidden")
    stub.setReply(() => ({ status: 404, body: { message: "Not Found" } }))
    const missing = yield* Effect.flip(readIssue({ baseUrl: stub.baseUrl, token: fakeToken, ...repository, issueNumber: 7 }))
    expect(missing.code).toBe("not-found")
    expect(missing.status).toBe(404)
    stub.setReply(() => ({ status: 500, body: { message: "Overloaded" } }))
    const retryable = yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository }))
    expect(retryable.code).toBe("api-error")
    expect(retryable.status).toBe(500)
    expect(stub.calls).toHaveLength(3)
  }).pipe(Effect.provide(Http)))
  it.live("maps rate limits from explicit and implied signals", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 429, headers: { "retry-after": "1" }, body: { message: "Too many requests" } }))
    const explicit = yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository }))
    expect(explicit.code).toBe("rate-limited")
    expect(explicit.retryAfterMs).toBe(1000)
    stub.setReply(() => ({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }, body: { message: "API rate limit exceeded" } }))
    const implied = yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository }))
    expect(implied.code).toBe("rate-limited")
    expect(stub.calls).toHaveLength(2)
  }).pipe(Effect.provide(Http)))
  it.live("rejects malformed payloads and unusable references without network", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: { labels: [] } }))
    expect((yield* Effect.flip(readIssue({ baseUrl: stub.baseUrl, token: fakeToken, ...repository, issueNumber: 7 }))).code).toBe("invalid-contract")
    stub.setReply(() => ({ status: 200, body: {} }))
    expect((yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository }))).code).toBe("invalid-contract")
    for (const input of [
      { baseUrl: "", token: fakeToken, ...repository },
      { baseUrl: "not a url", token: fakeToken, ...repository },
      { baseUrl: stub.baseUrl, token: "", ...repository },
      { baseUrl: stub.baseUrl, token: fakeToken, owner: "has/slash", repo: "hello" }
    ]) {
      const error = yield* Effect.flip(getRepositoryLabels(input))
      expect(error.code).toBe("invalid-contract")
      expect(encode(error)).not.toContain(fakeToken)
    }
    const badIssue = yield* Effect.flip(readIssue({ baseUrl: stub.baseUrl, token: fakeToken, ...repository, issueNumber: 0 }))
    expect(badIssue.code).toBe("invalid-contract")
    expect(stub.calls).toHaveLength(2)
  }).pipe(Effect.provide(Http)))
  it.live("reports unreachable endpoints as connection failures", () => Effect.gen(function*() {
    const error = yield* Effect.flip(getRepositoryLabels({ baseUrl: "http://127.0.0.1:1", token: fakeToken, ...repository, timeoutMs: 2000 }))
    expect(error.code).toBe("connection-failed")
    expect(encode(error)).not.toContain(fakeToken)
  }).pipe(Effect.provide(Http)))
  it.live("times out hanging responses within the configured deadline", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: githubLabelsBody(["late"]), hang: true }))
    const error = yield* Effect.flip(getRepositoryLabels({ baseUrl: stub.baseUrl, token: fakeToken, ...repository, timeoutMs: 100 }))
    expect(error.code).toBe("connection-failed")
    expect(stub.calls).toHaveLength(1)
  }).pipe(Effect.provide(Http)))
})

describe("github redacted status", () => {
  it.live("reports reachability auth and scopes without exposing the token", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({
      status: 200, headers: { "x-oauth-scopes": "repo, workflow", "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59", "x-ratelimit-reset": "3600" },
      body: githubRateLimitBody()
    }))
    const status = yield* checkGithubStatus({ token: fakeToken, baseUrl: stub.baseUrl })
    expect(status).toEqual({
      reachable: true, authOk: true, scopes: ["repo", "workflow"],
      rateLimit: { limit: 60, remaining: 59, reset: 3600 }
    })
    expect(encode(status)).not.toContain(fakeToken)
    const limits = yield* readRateLimit({ baseUrl: stub.baseUrl, token: fakeToken })
    expect(limits.scopes).toEqual(["repo", "workflow"])
    expect(limits.rateLimit).toEqual({ limit: 60, remaining: 59, reset: 3600 })
  }).pipe(Effect.provide(Http)))
  it.live("reports denied and unreachable endpoints without exposing the token", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 401, body: { message: "Bad credentials" } }))
    expect(yield* checkGithubStatus({ token: fakeToken, baseUrl: stub.baseUrl })).toEqual({ reachable: true, authOk: false, scopes: [] })
    expect(yield* checkGithubStatus({ token: fakeToken, baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 })).toEqual({ reachable: false, authOk: false, scopes: [] })
    expect(encode(yield* checkGithubStatus({ token: fakeToken, baseUrl: stub.baseUrl }))).not.toContain(fakeToken)
  }).pipe(Effect.provide(Http)))
})

describe("github label application", () => {
  it.live("writes the union once and skips the write when labels are present", () => Effect.gen(function*() {
    const stub = yield* withStub
    let current: ReadonlyArray<string> = ["existing"]
    stub.setReply((call) => {
      if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: current }) }
      if (call.method === "PATCH") {
        current = Schema.decodeUnknownSync(Schema.Struct({ labels: Schema.Array(Schema.String) }))(call.body).labels
        return { status: 200, body: githubIssueBody({ labels: current }) }
      }
      return { status: 404, body: { message: "Not Found" } }
    })
    const applied = yield* applyGithubLabels({ repository, issueNumber: 7, labels: ["type: bug"] }, fakeToken, optionsFor(stub.baseUrl))
    expect(applied).toEqual({ applied: true })
    expect(current).toEqual(["existing", "type: bug"])
    const patch = stub.calls.find((call) => call.method === "PATCH")
    expect(patch?.authorization).toBe(`Bearer ${fakeToken}`)
    expect(patch?.body).toEqual({ labels: ["existing", "type: bug"] })
    expect(patch?.path).toBe("/repos/octo/hello/issues/7")
    const repeated = yield* applyGithubLabels({ repository, issueNumber: 7, labels: ["type: bug"] }, fakeToken, optionsFor(stub.baseUrl))
    expect(repeated).toEqual({ applied: false })
    expect(stub.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(stub.calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET"])
  }).pipe(Effect.provide(Http)))
  it.live("refuses unlisted repositories and invalid labels before any network", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: githubIssueBody({ labels: [] }) }))
    const denied = yield* Effect.flip(applyGithubLabels(
      { repository: { owner: "elsewhere", repo: "hello" }, issueNumber: 7, labels: ["type: bug"] }, fakeToken, optionsFor(stub.baseUrl)
    ))
    expect(denied.code).toBe("not-allowed")
    const invalid = yield* Effect.flip(applyGithubLabels({ repository, issueNumber: 7, labels: [] }, fakeToken, optionsFor(stub.baseUrl)))
    expect(invalid.code).toBe("invalid-contract")
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Http)))
  it.live("backs off on rate limits instead of retrying hot", () => Effect.gen(function*() {
    const stub = yield* withStub
    let attempts = 0
    stub.setReply((call) => {
      attempts += 1
      if (call.method === "GET" && attempts === 1) {
        return { status: 429, headers: { "retry-after": "1" }, body: { message: "Too many requests" } }
      }
      if (call.method === "GET") return { status: 200, body: githubIssueBody({ labels: [] }) }
      return { status: 200, body: githubIssueBody({ labels: ["type: bug"] }) }
    })
    const started = yield* Clock.currentTimeMillis
    const applied = yield* applyGithubLabels({ repository, issueNumber: 7, labels: ["type: bug"] }, fakeToken, { ...optionsFor(stub.baseUrl), maxRetries: 2 })
    const finished = yield* Clock.currentTimeMillis
    expect(applied).toEqual({ applied: true })
    expect(finished - started).toBeGreaterThanOrEqual(900)
    expect(stub.calls.filter((call) => call.method === "GET")).toHaveLength(2)
  }).pipe(Effect.provide(Http)))
  it.live("fails retryable reads once the bounded budget is spent", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 500, body: { message: "Overloaded" } }))
    const error = yield* Effect.flip(applyGithubLabels({ repository, issueNumber: 7, labels: ["type: bug"] }, fakeToken, { ...optionsFor(stub.baseUrl), maxRetries: 1 }))
    expect(error.code).toBe("api-error")
    expect(error.status).toBe(500)
    expect(encode(error)).not.toContain(fakeToken)
    expect(stub.calls).toHaveLength(2)
  }).pipe(Effect.provide(Http)))
  it.live("reads issues and repository labels through the allow-list", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply((call) => {
      if (call.path === "/rate_limit") return { status: 200, body: githubRateLimitBody() }
      if (call.path.startsWith("/repos/octo/hello/issues/7")) {
        return { status: 200, body: githubIssueBody({ labels: ["existing"], title: "Boom", body: "Details" }) }
      }
      if (call.path.startsWith("/repos/octo/hello/labels")) {
        const page = call.path.includes("page=2") ? ["type: question"] : ["existing", "type: bug"]
        const headers = page[0] === "existing" ? { link: `<${stub.baseUrl}/repos/octo/hello/labels?per_page=100&page=2>; rel="next"` } : {}
        return { status: 200, headers, body: githubLabelsBody(page) }
      }
      return { status: 404, body: { message: "Not Found" } }
    })
    expect(yield* readGithubIssue({ repository, issueNumber: 7 }, fakeToken, optionsFor(stub.baseUrl))).toEqual({
      issueNumber: 7, title: "Boom", body: "Details", labels: ["existing"]
    })
    expect(yield* listGithubLabels({ repository }, fakeToken, optionsFor(stub.baseUrl))).toEqual(["existing", "type: bug", "type: question"])
    const written = yield* writeIssueLabels({ baseUrl: stub.baseUrl, token: fakeToken, owner: "octo", repo: "hello", issueNumber: 7, labels: ["existing"] })
    expect(written).toEqual(["existing"])
    const denied = yield* Effect.flip(listGithubLabels({ repository: { owner: "elsewhere", repo: "hello" } }, fakeToken, optionsFor(stub.baseUrl)))
    expect(denied.code).toBe("not-allowed")
  }).pipe(Effect.provide(Http)))
})
