import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { HttpClient } from "effect/http"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { buildGithubClassificationProcess, githubLabelActionReference } from "@expand/contracts/automation/github"
import type { IntegrationConfiguration } from "@expand/contracts/automation"
import { checkGithubLive, makeGithubServerExtension, resolveGithubToken } from "../../automation/github-client.js"
import { githubIssueBody, startGithubStub } from "../fixtures/automation-github-stub.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Credentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(Credentials, Configurations, NodeHttpClient.layerFetch)

const fakeToken = "stub-github-token-for-tests-only"
const scope = { ownerId: "github-owner", projectId: "github-project" }
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
}
const githubIntegration: IntegrationConfiguration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" } }
}
const optionsFor = (baseUrl: string) => ({ baseUrl, allowedRepos: [{ owner: "octo", repo: "hello" }] })
const withStub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const seed = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const configurations = yield* ConfigurationRepository
  yield* credentials.putCredential(scope, "github-token", fakeToken, 0)
  yield* configurations.putIntegration(scope, githubIntegration, 0)
})

describe("github credential wiring", () => {
  it.live("resolves the token by reference without exposing it in redacted reads", () => Effect.gen(function*() {
    const stub = yield* withStub
    yield* seed
    expect(yield* resolveGithubToken(scope, githubIntegration)).toBe(fakeToken)
    const credentials = yield* CredentialRepository
    expect(yield* credentials.status(scope, "github-token")).toEqual({ credentialId: "github-token", version: 1, configured: true })
    expect(encode(yield* credentials.list(scope))).not.toContain(fakeToken)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
  it.live("fails missing credentials before any network request", () => Effect.gen(function*() {
    const stub = yield* withStub
    const error = yield* Effect.flip(resolveGithubToken(scope, githubIntegration))
    expect(error.code).toBe("missing-credential")
    expect(error.message).not.toContain("github-token")
    expect(encode(error)).not.toContain(fakeToken)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
  it.live("rejects non-string credential secrets without leaking them", () => Effect.gen(function*() {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "github-token", { token: fakeToken }, 0)
    const error = yield* Effect.flip(resolveGithubToken(scope, githubIntegration))
    expect(error.code).toBe("invalid-credential")
    expect(encode(error)).not.toContain(fakeToken)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
})

describe("github connector and registered action", () => {
  it.live("labels through the registry preserving existing labels idempotently", () => Effect.gen(function*() {
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
    yield* seed
    const server = makeGithubServerExtension(optionsFor(stub.baseUrl))
    const registry = new AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient>()
    yield* registry.register(server.extension)
    const kinds = registry.catalog().definitions.map((entry) => entry.definition.id)
    expect(kinds).toContain("github:integration")
    expect(kinds).toContain("github:label-issue")
    const process = yield* buildGithubClassificationProcess("github", classification)
    const configuration = {
      schemaVersion: 1 as const, kind: "routine-configuration" as const,
      reference: { routineId: "triage", revision: 1 }, scope,
      configuration: classification, integrations: [githubIntegration], process
    }
    const authority = {
      schemaVersion: 1 as const, kind: "invocation-authority" as const,
      scope, configuration: { routineId: "triage", revision: 1 }, integrationIds: ["github"],
      actionGrants: [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }]
    }
    const invocation = {
      configuration, stepId: "label-bug",
      triggerPayload: { issueNumber: 7, title: "Boom" },
      decision: { schemaVersion: 1 as const, kind: "selected" as const, outcomeId: "bug", data: {} },
      mode: "live" as const
    }
    expect(yield* registry.invokeAction(invocation, authority)).toEqual({ applied: true })
    expect(current).toEqual(["existing", "type: bug"])
    const patch = stub.calls.find((call) => call.method === "PATCH")
    expect(patch?.path).toBe("/repos/octo/hello/issues/7")
    expect(patch?.authorization).toBe(`Bearer ${fakeToken}`)
    expect(patch?.body).toEqual({ labels: ["existing", "type: bug"] })
    expect(yield* registry.invokeAction(invocation, authority)).toEqual({ applied: false })
    expect(stub.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(stub.calls.map((call) => call.method)).toEqual(["GET", "PATCH", "GET"])
  }).pipe(Effect.provide(Live)))
  it.live("refuses unlisted repositories through the registered action without network", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: githubIssueBody({ labels: [] }) }))
    yield* seed
    const server = makeGithubServerExtension({ baseUrl: stub.baseUrl, allowedRepos: [{ owner: "elsewhere", repo: "other" }] })
    const registry = new AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient>()
    yield* registry.register(server.extension)
    const process = yield* buildGithubClassificationProcess("github", classification)
    const configuration = {
      schemaVersion: 1 as const, kind: "routine-configuration" as const,
      reference: { routineId: "triage", revision: 1 }, scope,
      configuration: classification, integrations: [githubIntegration], process
    }
    const authority = {
      schemaVersion: 1 as const, kind: "invocation-authority" as const,
      scope, configuration: { routineId: "triage", revision: 1 }, integrationIds: ["github"],
      actionGrants: [{ action: githubLabelActionReference, integrationId: "github", capabilities: ["label"] }]
    }
    const error = yield* Effect.flip(registry.invokeAction({
      configuration, stepId: "label-bug",
      triggerPayload: { issueNumber: 7, title: "Boom" },
      decision: { schemaVersion: 1 as const, kind: "selected" as const, outcomeId: "bug", data: {} },
      mode: "live" as const
    }, authority))
    expect(error.code).toBe("handler-failed")
    expect(error.failure?.code).toBe("not-allowed")
    expect(encode(error)).not.toContain(fakeToken)
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
})

describe("github live verification", () => {
  it.live("reports blocked checks without credentials and without network", () => Effect.gen(function*() {
    const stub = yield* withStub
    const checked = yield* checkGithubLive({ scope, integration: githubIntegration, options: optionsFor(stub.baseUrl) })
    expect(checked).toMatchObject({ ok: false, blocked: true, reason: expect.any(String) })
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
  it.live("records the live GitHub outcome once a token is available", () => Effect.gen(function*() {
    const token = yield* Config.option(Config.String("GITHUB_TOKEN"))
    if (Option.isNone(token)) {
      const checked = yield* checkGithubLive({
        scope, integration: githubIntegration, options: { allowedRepos: [{ owner: "octo", repo: "hello" }] }
      })
      expect(checked.blocked).toBe(true)
      return
    }
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "github-token", token.value, 0)
    const checked = yield* checkGithubLive({
      scope, integration: githubIntegration, options: { allowedRepos: [{ owner: "octo", repo: "hello" }] }
    })
    expect(checked.blocked).toBe(false)
    expect(checked.ok).toBe(true)
    expect(checked.authOk).toBe(true)
    expect(encode(checked)).not.toContain(token.value)
  }).pipe(Effect.provide(Live)))
})
