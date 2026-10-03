import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { applyGithubLabel, checkGithubConnection, listGithubLabels, makeGithubConnectorExtension, readGithubIssue } from "../../automation/github-connector.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const WithCredentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(WithCredentials, NodeHttpClient.layerFetch)
const fakeToken = "stub-github-token-for-integration-only"
const secretBytes = new TextEncoder().encode(fakeToken)
const scope = { ownerId: "github-owner", projectId: "github-project" }
const integration = {
  schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" } }
}
const withStub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const seed = Effect.gen(function* () {
  const configurations = yield* ConfigurationRepository
  const credentials = yield* CredentialRepository
  yield* credentials.putCredential(scope, "github-token", secretBytes, 0)
  yield* configurations.putIntegration(scope, integration, 0)
})

describe("github connector integration", () => {
  it.live("lists labels and reads issues through credential references without persisting secrets", () => Effect.gen(function* () {
    const stub = yield* withStub
    yield* seed
    stub.setLabels(["bug", "question"])
    stub.setIssue(7, { title: "Boom", body: "Body", labels: ["bug"] })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const labels = yield* listGithubLabels(scope, integration, options)
    expect(labels).toEqual(["bug", "question"])
    const issue = yield* readGithubIssue(scope, integration, 7, options)
    expect(issue).toEqual({ number: 7, title: "Boom", body: "Body", labels: ["bug"] })
    expect(encode({ labels, issue })).not.toContain(fakeToken)
    expect(stub.calls.every((call) => call.authorization === `Bearer ${fakeToken}`)).toBe(true)
  }).pipe(Effect.provide(Live)))
  it.live("applies configured labels through the registered action while preserving existing labels", () => Effect.gen(function* () {
    const connector = makeGithubConnectorExtension()
    const registry = new AutomationRegistry()
    yield* registry.register(connector.extension)
    yield* seed
    const stub = yield* withStub
    stub.setIssue(7, { title: "Boom", labels: ["old"] })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const scoped = makeGithubConnectorExtension(options)
    const scopedRegistry = new AutomationRegistry()
    yield* scopedRegistry.register(scoped.extension)
    const configurations = yield* ConfigurationRepository
    const stored = yield* configurations.getIntegration(scope, "github")
    expect(stored !== null).toBe(true)
    const first = yield* applyGithubLabel(scope, integration, 7, "type: bug", options)
    expect(first).toEqual({ applied: true })
    expect(stub.getIssueLabels(7)).toEqual(["old", "type: bug"])
    const postCalls = stub.calls.filter((call) => call.method === "POST")
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0]?.body).toEqual({ labels: ["type: bug"] })
    const second = yield* applyGithubLabel(scope, integration, 7, "type: bug", options)
    expect(second).toEqual({ applied: true })
    expect(stub.getIssueLabels(7)).toEqual(["old", "type: bug"])
    expect(stub.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    const routineConfiguration = {
      schemaVersion: 1, kind: "routine-configuration",
      reference: { routineId: "triage", revision: 1 },
      scope, configuration: {},
      integrations: [integration],
      process: {
        schemaVersion: 1, kind: "process",
        trigger: {
          definition: { id: "github:issue-opened", version: 1 },
          integration: { id: "github", definition: { id: "github:integration", version: 1 } },
          configuration: {}
        },
        actions: {
          triggered: [{
            id: "label-1",
            action: { id: "github:label-issue", version: 1 },
            integration: { id: "github", definition: { id: "github:integration", version: 1 } },
            bindings: {
              issueNumber: { kind: "field", source: "trigger", path: ["issueNumber"] },
              label: { kind: "literal", value: "type: question" }
            }
          }]
        }
      }
    }
    const authority = {
      schemaVersion: 1, kind: "invocation-authority", scope,
      configuration: { routineId: "triage", revision: 1 },
      integrationIds: ["github"],
      actionGrants: [{ action: { id: "github:label-issue", version: 1 }, integrationId: "github", capabilities: ["label"] }]
    }
    const result = yield* scopedRegistry.invokeAction(
      { configuration: routineConfiguration, stepId: "label-1", triggerPayload: { issueNumber: 7, title: "Boom" }, mode: "live" },
      authority
    )
    expect(result).toEqual({ applied: true })
    expect(stub.getIssueLabels(7)).toEqual(["old", "type: bug", "type: question"])
    expect(encode(result)).not.toContain(fakeToken)
  }).pipe(Effect.provide(Live)))
  it.live("denies invocations when the repository does not match the permitted configuration", () => Effect.gen(function* () {
    const stub = yield* withStub
    yield* seed
    stub.setIssue(7, { title: "Boom", labels: ["old"] })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const scoped = makeGithubConnectorExtension(options)
    const scopedRegistry = new AutomationRegistry()
    yield* scopedRegistry.register(scoped.extension)
    const foreign = { ...integration, configuration: { owner: "octo", repo: "other" } }
    const routineConfiguration = {
      schemaVersion: 1, kind: "routine-configuration",
      reference: { routineId: "triage", revision: 1 },
      scope, configuration: {},
      integrations: [foreign],
      process: {
        schemaVersion: 1, kind: "process",
        trigger: {
          definition: { id: "github:issue-opened", version: 1 },
          integration: { id: "github", definition: { id: "github:integration", version: 1 } },
          configuration: {}
        },
        actions: {
          triggered: [{
            id: "label-1",
            action: { id: "github:label-issue", version: 1 },
            integration: { id: "github", definition: { id: "github:integration", version: 1 } },
            bindings: {
              issueNumber: { kind: "field", source: "trigger", path: ["issueNumber"] },
              label: { kind: "literal", value: "type: bug" }
            }
          }]
        }
      }
    }
    const authority = {
      schemaVersion: 1, kind: "invocation-authority", scope,
      configuration: { routineId: "triage", revision: 1 },
      integrationIds: ["github"],
      actionGrants: [{ action: { id: "github:label-issue", version: 1 }, integrationId: "github", capabilities: ["label"] }]
    }
    const error = yield* Effect.flip(scopedRegistry.invokeAction(
      { configuration: routineConfiguration, stepId: "label-1", triggerPayload: { issueNumber: 7, title: "Boom" }, mode: "live" },
      authority
    ))
    expect(error.code).toBe("handler-failed")
    expect(error.failure?.code).toBe("invalid-contract")
    expect(stub.calls.filter((call) => call.method === "POST")).toHaveLength(0)
    expect(stub.getIssueLabels(7)).toEqual(["old"])
    expect(encode(error)).not.toContain(fakeToken)
    const status = yield* checkGithubConnection(scope, integration, options)
    expect(status.ok).toBe(true)
  }).pipe(Effect.provide(Live)))
})
