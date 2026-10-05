import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { checkSonarConnection, makeSonarConnectorExtension, readSonarFinding } from "../../automation/sonar-connector.js"
import type { SonarConnectorServices } from "../../automation/sonar-connector.js"
import { getSonarIssue, listSonarIssues } from "../../automation/sonar-transport.js"
import { startSonarStub } from "../fixtures/automation-sonar-stub.js"
import { sonarAutoFixTemplate } from "@expand/contracts/automation/sonarqube"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(WithCredentials, NodeHttpClient.layerFetch)
const fakeToken = "stub-sonar-token-for-tests-only"
const secretBytes = new TextEncoder().encode(fakeToken)
const scope = { ownerId: "sonar-owner", projectId: "sonar-project" }
const integration = {
  schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "sonar",
  definition: { id: "sonarqube:integration" as const, version: 1 as const },
  configuration: { baseUrl: "http://127.0.0.1:9000", projectKey: "test-project" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "sonar-token" } }
}
const withStub = Effect.acquireRelease(startSonarStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const servicesFor = Effect.gen(function*() {
  const context = yield* Layer.build(Live)
  return {
    configurations: Context.get(context, ConfigurationRepository),
    credentials: Context.get(context, CredentialRepository),
    http: Context.get(context, HttpClient.HttpClient)
  } satisfies SonarConnectorServices
})
const withServices = <A, E, R>(body: (services: SonarConnectorServices) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(servicesFor, (services) => Effect.provide(Layer.mergeAll(
    Layer.succeed(ConfigurationRepository, services.configurations),
    Layer.succeed(CredentialRepository, services.credentials),
    Layer.succeed(HttpClient.HttpClient, services.http)
  ))(body(services)))

describe("sonar transport errors", () => {
  it.live("maps authentication and missing failures without retry", () => Effect.gen(function*() {
    const stub = yield* withStub
    const cases = [
      { status: 401, code: "auth" },
      { status: 403, code: "forbidden" }
    ] as const
    for (const entry of cases) {
      stub.setReply(() => ({ status: entry.status, body: { message: "stub" } }))
      const error = yield* Effect.flip(getSonarIssue(stub.baseUrl, "issue-1", fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }))
      expect(error.code).toBe(entry.code)
      expect(error.status).toBe(entry.status)
      expect(error.message).not.toContain(fakeToken)
    }
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
})

describe("sonar connector integration", () => {
  it.live("lists findings and reads issues through credential references without persisting secrets", () => withServices((services) => Effect.gen(function*() {
    const stub = yield* withStub
    yield* services.credentials.putCredential(scope, "sonar-token", secretBytes, 0)
    yield* services.configurations.putIntegration(scope, { ...integration, configuration: { baseUrl: stub.baseUrl, projectKey: "test-project" } }, 0)
    stub.setIssue("issue-1", { status: "OPEN", severity: "MAJOR", rule: "rule-1", message: "Null check" })
    stub.setIssue("issue-2", { status: "CLOSED", severity: "MINOR", rule: "rule-2", message: "Fixed" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const scopedIntegration = { ...integration, configuration: { baseUrl: stub.baseUrl, projectKey: "test-project" } }
    const found = yield* readSonarFinding(scope, scopedIntegration, "issue-1", options)
    expect(found).toEqual({ issueKey: "issue-1", status: "OPEN", severity: "MAJOR", rule: "rule-1", message: "Null check" })
    const listed = yield* listSonarIssues(stub.baseUrl, "test-project", fakeToken, options)
    expect(listed.length).toBe(1)
    expect(listed[0]!.key).toBe("issue-1")
    expect(encode({ found, listed })).not.toContain(fakeToken)
    expect(stub.calls.every((call) => call.authorization === `Bearer ${fakeToken}`)).toBe(true)
  })))
  it.live("registers the sonarqube integration and reports connection status without exposing the token", () => withServices((services) => Effect.gen(function*() {
    const stub = yield* withStub
    const connector = makeSonarConnectorExtension(undefined, services)
    const registry = new AutomationRegistry()
    yield* registry.register(connector.extension)
    const catalog = registry.catalog()
    expect(catalog.definitions.some((entry) => entry.kind === "integration" && entry.definition.id === "sonarqube:integration")).toBe(true)
    expect(catalog.definitions.some((entry) => entry.kind === "action" && entry.definition.id === "sonarqube:fetch-finding")).toBe(true)
    expect(catalog.definitions.some((entry) => entry.kind === "action" && entry.definition.id === "sonarqube:verify-fixed")).toBe(true)
    expect(sonarAutoFixTemplate.definition.id).toBe("sonarqube:auto-fix")
    yield* services.credentials.putCredential(scope, "sonar-token", secretBytes, 0)
    yield* services.configurations.putIntegration(scope, { ...integration, configuration: { baseUrl: stub.baseUrl, projectKey: "test-project" } }, 0)
    stub.setIssue("issue-1", { status: "OPEN", severity: "MAJOR", rule: "rule-1", message: "Open" })
    const scopedIntegration = { ...integration, configuration: { baseUrl: stub.baseUrl, projectKey: "test-project" } }
    const ok = yield* checkSonarConnection(scope, scopedIntegration, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(ok.ok).toBe(true)
    expect(ok.configured).toBe(true)
    expect(ok.issues).toBe(1)
    expect(encode(ok)).not.toContain(fakeToken)
    const missing = yield* checkSonarConnection({ ownerId: "other", projectId: "other" }, scopedIntegration, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(missing.ok).toBe(false)
    expect(missing.configured).toBe(false)
  })))
  it.live("rejects unknown findings and enforces configured project permissions", () => withServices((services) => Effect.gen(function*() {
    const stub = yield* withStub
    yield* services.credentials.putCredential(scope, "sonar-token", secretBytes, 0)
    yield* services.configurations.putIntegration(scope, { ...integration, configuration: { baseUrl: stub.baseUrl, projectKey: "test-project" } }, 0)
    stub.setIssue("issue-9", { status: "OPEN", severity: "MAJOR", rule: "rule-9", message: "Open" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const scopedIntegration = { ...integration, configuration: { baseUrl: stub.baseUrl, projectKey: "test-project" } }
    const missing = yield* Effect.exit(readSonarFinding(scope, scopedIntegration, "missing-issue", options))
    expect(missing._tag).toBe("Failure")
    const connector = makeSonarConnectorExtension(options, services)
    const registry = new AutomationRegistry()
    yield* registry.register(connector.extension)
    const mismatch = yield* Effect.exit(connector.fetchAction.invoke({ issueKey: "issue-9" }, { baseUrl: stub.baseUrl, projectKey: "other-project" }, {
      scope, routineId: "sonar", configurationRevision: 1, integrationId: "sonar", mode: "live"
    }))
    expect(mismatch._tag).toBe("Failure")
    const verifyOpen = yield* Effect.exit(connector.verifyAction.invoke({ issueKey: "issue-9" }, { baseUrl: stub.baseUrl, projectKey: "test-project" }, {
      scope, routineId: "sonar", configurationRevision: 1, integrationId: "sonar", mode: "live"
    }))
    expect(verifyOpen._tag).toBe("Failure")
  })))
})
