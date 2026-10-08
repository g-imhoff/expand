import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { fileURLToPath } from "node:url"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { resetCodingAdaptersForTests } from "../../automation/coding-connector.js"
import { clearCodingAdapters } from "../../automation/coding-agent.js"
import { makeSkillConnectorExtension } from "../../automation/skill-connector.js"
import type { SkillConnectorServices } from "../../automation/skill-connector.js"
import { makeSonarConnectorExtension } from "../../automation/sonar-connector.js"
import { startSonarStub } from "../fixtures/automation-sonar-stub.js"
import { sampleWriteFileSkill, sampleSkills } from "../../automation/sample-skills.js"
import { DefaultAutomationWorkerOptions, processRun } from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { buildSonarAutoFixProcess } from "@expand/contracts/automation/sonarqube"

const scope = { ownerId: "sonar-fix-owner", projectId: "sonar-fix-project" }
const stubPath = fileURLToPath(new URL("../fixtures/automation-acp-stub.mjs", import.meta.url))

const setupLayers = () => {
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const registry = new AutomationRegistry()
  const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
    Layer.provideMerge(Creds)
  )
  return { registry, Live }
}

const unusedDecide: AutomationWorkerEnvironment["decide"] = () =>
  Effect.fail({ code: "unused", message: "unused" }) as never

describe("automation sonarqube fix", () => {
  it.live("completes fetch, repair skill and verify when the stub reports the finding resolved", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const sonarStub = yield* startSonarStub()
      try {
        sonarStub.setIssue("fix-1", { status: "CLOSED", severity: "MAJOR", rule: "rule-1", message: "Null check" })
        const fs = yield* FileSystem.FileSystem
        const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "sonar-fix-success-" })
        const { registry, Live } = setupLayers()
        const program = Effect.gen(function*() {
          const routines = yield* RoutineService
          const executions = yield* ExecutionRepository
          const configurations = yield* ConfigurationRepository
          const credentials = yield* CredentialRepository
          const sql = yield* SqlClient
          const http = yield* HttpClient.HttpClient
          const skillServices: SkillConnectorServices = { configurations, credentials }
          yield* registry.register(makeSonarConnectorExtension({ baseUrl: sonarStub.baseUrl, timeoutMs: 8000, maxRetries: 0 }, { configurations, credentials, http }).extension)
          yield* registry.register(
            makeSkillConnectorExtension(
              { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, skills: sampleSkills },
              skillServices
            ).extension
          )
          yield* credentials.putCredential(scope, "sonar-token", new TextEncoder().encode("sonar-secret"), 0)
          yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("coding-secret"), 0)
          const process = yield* buildSonarAutoFixProcess("sonar", "coding", {
            repairSkillId: "sample-write-file",
            repairInputs: { content: "fix-finding" }
          })
          yield* routines.create(scope, {
            routineId: "sonar-fix",
            configuration: { repairSkillId: "sample-write-file", repairInputs: { content: "fix-finding" } },
            integrations: [
              {
                schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "sonar",
                definition: { id: "sonarqube:integration" as const, version: 1 as const },
                configuration: { baseUrl: sonarStub.baseUrl, projectKey: "test-project" },
                credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "sonar-token" } }
              },
              {
                schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "coding",
                definition: { id: "coding-agent:integration" as const, version: 1 as const },
                configuration: { repository: "octo/hello" },
                credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "coding-token" } }
              }
            ],
            process
          })
          const delivery = {
            schemaVersion: 1 as const,
            id: "input-sonar-1",
            scope,
            integration: { id: "sonar", definition: { id: "sonarqube:integration" as const, version: 1 as const } },
            externalId: "input-sonar-1",
            trigger: { id: "sonarqube:finding-opened" as const, version: 1 as const },
            payload: { issueKey: "fix-1", projectKey: "test-project", rule: "rule-1", severity: "MAJOR" }
          }
          const authority = {
            schemaVersion: 1 as const, kind: "invocation-authority" as const, scope,
            configuration: { routineId: "sonar-fix", revision: 1 as const },
            integrationIds: ["sonar", "coding"],
            actionGrants: [
              { action: { id: "sonarqube:fetch-finding", version: 1 }, integrationId: "sonar", capabilities: ["read"] },
              { action: { id: "coding-skill:execute", version: 1 }, integrationId: "coding", capabilities: ["execute"] },
              { action: { id: "sonarqube:verify-fixed", version: 1 }, integrationId: "sonar", capabilities: ["verify"] }
            ]
          }
          const run = {
            schemaVersion: 1 as const, kind: "run" as const, id: "run-sonar-1", scope,
            configuration: { routineId: "sonar-fix", revision: 1 as const },
            input: { kind: "input-reference" as const, id: "input-sonar-1" },
            mode: "live" as const, authority, state: { kind: "queued" as const }, actions: []
          }
          yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-sonar-1", run }] })
          const environment: AutomationWorkerEnvironment = {
            services: { configurations, credentials, executions, sql, http },
            registry, routines, decide: unusedDecide
          }
          const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1 }, scope, "run-sonar-1")
          expect(outcome).toBe("completed")
          const stored = (yield* executions.getRun(scope, "run-sonar-1"))!
          expect(stored.value.state.kind).toBe("succeeded")
          const history = (yield* executions.history(scope, "run-sonar-1"))!
          const succeeded = history.attempts.filter((entry) => entry.kind === "action" && entry.status === "completed" && entry.outcome.kind === "succeeded")
          expect(succeeded.length).toBe(3)
          const verify = succeeded.find((entry) => entry.stepId === "verify-fixed")
          expect(verify).toBeDefined()
          const verifyResult = (verify as unknown as { outcome: { result: { resolved: boolean; status: string } } }).outcome.result
          expect(verifyResult.resolved).toBe(true)
          expect(verifyResult.status).toBe("CLOSED")
          expect(sampleWriteFileSkill.id).toBe("sample-write-file")
          const encoded = yield* Schema.encodeUnknownEffect(Schema.Json)(verifyResult as unknown as Schema.Json)
          expect(encoded).toBeDefined()
        })
        const Full = Layer.mergeAll(Live, NodeServices.layer)
        yield* program.pipe(Effect.provide(Full))
      } finally {
        sonarStub.close()
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("retains failure evidence when the stub still reports the finding open", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const sonarStub = yield* startSonarStub()
      try {
        sonarStub.setIssue("fix-2", { status: "OPEN", severity: "MAJOR", rule: "rule-1", message: "Still open" })
        const fs = yield* FileSystem.FileSystem
        const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "sonar-fix-failure-" })
        const { registry, Live } = setupLayers()
        const program = Effect.gen(function*() {
          const routines = yield* RoutineService
          const executions = yield* ExecutionRepository
          const configurations = yield* ConfigurationRepository
          const credentials = yield* CredentialRepository
          const sql = yield* SqlClient
          const http = yield* HttpClient.HttpClient
          const skillServices: SkillConnectorServices = { configurations, credentials }
          yield* registry.register(makeSonarConnectorExtension({ baseUrl: sonarStub.baseUrl, timeoutMs: 8000, maxRetries: 0 }, { configurations, credentials, http }).extension)
          yield* registry.register(
            makeSkillConnectorExtension(
              { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, skills: sampleSkills },
              skillServices
            ).extension
          )
          yield* credentials.putCredential(scope, "sonar-token", new TextEncoder().encode("sonar-secret"), 0)
          yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("coding-secret"), 0)
          const process = yield* buildSonarAutoFixProcess("sonar", "coding", {
            repairSkillId: "sample-write-file",
            repairInputs: { content: "fix-finding" }
          })
          yield* routines.create(scope, {
            routineId: "sonar-fix-fail",
            configuration: { repairSkillId: "sample-write-file", repairInputs: { content: "fix-finding" } },
            integrations: [
              {
                schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "sonar",
                definition: { id: "sonarqube:integration" as const, version: 1 as const },
                configuration: { baseUrl: sonarStub.baseUrl, projectKey: "test-project" },
                credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "sonar-token" } }
              },
              {
                schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "coding",
                definition: { id: "coding-agent:integration" as const, version: 1 as const },
                configuration: { repository: "octo/hello" },
                credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "coding-token" } }
              }
            ],
            process
          })
          const delivery = {
            schemaVersion: 1 as const,
            id: "input-sonar-2",
            scope,
            integration: { id: "sonar", definition: { id: "sonarqube:integration" as const, version: 1 as const } },
            externalId: "input-sonar-2",
            trigger: { id: "sonarqube:finding-opened" as const, version: 1 as const },
            payload: { issueKey: "fix-2", projectKey: "test-project", rule: "rule-1", severity: "MAJOR" }
          }
          const authority = {
            schemaVersion: 1 as const, kind: "invocation-authority" as const, scope,
            configuration: { routineId: "sonar-fix-fail", revision: 1 as const },
            integrationIds: ["sonar", "coding"],
            actionGrants: [
              { action: { id: "sonarqube:fetch-finding", version: 1 }, integrationId: "sonar", capabilities: ["read"] },
              { action: { id: "coding-skill:execute", version: 1 }, integrationId: "coding", capabilities: ["execute"] },
              { action: { id: "sonarqube:verify-fixed", version: 1 }, integrationId: "sonar", capabilities: ["verify"] }
            ]
          }
          const run = {
            schemaVersion: 1 as const, kind: "run" as const, id: "run-sonar-2", scope,
            configuration: { routineId: "sonar-fix-fail", revision: 1 as const },
            input: { kind: "input-reference" as const, id: "input-sonar-2" },
            mode: "live" as const, authority, state: { kind: "queued" as const }, actions: []
          }
          yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-sonar-2", run }] })
          const environment: AutomationWorkerEnvironment = {
            services: { configurations, credentials, executions, sql, http },
            registry, routines, decide: unusedDecide
          }
          const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-sonar-2")
          expect(outcome).toBe("failed")
          const stored = (yield* executions.getRun(scope, "run-sonar-2"))!
          expect(stored.value.state.kind).toBe("failed")
          const history = (yield* executions.history(scope, "run-sonar-2"))!
          const failed = history.attempts.filter((entry) => entry.kind === "action" && entry.status === "completed" && entry.outcome.kind === "failed")
          expect(failed.length).toBeGreaterThanOrEqual(1)
          const verifyFailed = failed.find((entry) => entry.stepId === "verify-fixed")
          expect(verifyFailed).toBeDefined()
        })
        const Full = Layer.mergeAll(Live, NodeServices.layer)
        yield* program.pipe(Effect.provide(Full))
      } finally {
        sonarStub.close()
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("denies publishing when the authority omits the verify capability", () =>
    Effect.gen(function*() {
      const sonarStub = yield* startSonarStub()
      try {
        sonarStub.setIssue("fix-3", { status: "CLOSED", severity: "MAJOR", rule: "rule-1", message: "Closed" })
        const fs = yield* FileSystem.FileSystem
        const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "sonar-fix-denied-" })
        const { registry, Live } = setupLayers()
        const program = Effect.gen(function*() {
          const routines = yield* RoutineService
          const executions = yield* ExecutionRepository
          const configurations = yield* ConfigurationRepository
          const credentials = yield* CredentialRepository
          const sql = yield* SqlClient
          const http = yield* HttpClient.HttpClient
          const skillServices: SkillConnectorServices = { configurations, credentials }
          yield* registry.register(makeSonarConnectorExtension({ baseUrl: sonarStub.baseUrl, timeoutMs: 8000, maxRetries: 0 }, { configurations, credentials, http }).extension)
          yield* registry.register(
            makeSkillConnectorExtension(
              { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, skills: sampleSkills },
              skillServices
            ).extension
          )
          yield* credentials.putCredential(scope, "sonar-token", new TextEncoder().encode("sonar-secret"), 0)
          yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("coding-secret"), 0)
          const process = yield* buildSonarAutoFixProcess("sonar", "coding", {
            repairSkillId: "sample-write-file",
            repairInputs: { content: "fix-finding" }
          })
          yield* routines.create(scope, {
            routineId: "sonar-fix-denied",
            configuration: { repairSkillId: "sample-write-file", repairInputs: { content: "fix-finding" } },
            integrations: [
              {
                schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "sonar",
                definition: { id: "sonarqube:integration" as const, version: 1 as const },
                configuration: { baseUrl: sonarStub.baseUrl, projectKey: "test-project" },
                credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "sonar-token" } }
              },
              {
                schemaVersion: 1 as const, kind: "integration-configuration" as const, id: "coding",
                definition: { id: "coding-agent:integration" as const, version: 1 as const },
                configuration: { repository: "octo/hello" },
                credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "coding-token" } }
              }
            ],
            process
          })
          const delivery = {
            schemaVersion: 1 as const,
            id: "input-sonar-3",
            scope,
            integration: { id: "sonar", definition: { id: "sonarqube:integration" as const, version: 1 as const } },
            externalId: "input-sonar-3",
            trigger: { id: "sonarqube:finding-opened" as const, version: 1 as const },
            payload: { issueKey: "fix-3", projectKey: "test-project", rule: "rule-1", severity: "MAJOR" }
          }
          const authority = {
            schemaVersion: 1 as const, kind: "invocation-authority" as const, scope,
            configuration: { routineId: "sonar-fix-denied", revision: 1 as const },
            integrationIds: ["sonar", "coding"],
            actionGrants: [
              { action: { id: "sonarqube:fetch-finding", version: 1 }, integrationId: "sonar", capabilities: ["read"] },
              { action: { id: "coding-skill:execute", version: 1 }, integrationId: "coding", capabilities: ["execute"] }
            ]
          }
          const run = {
            schemaVersion: 1 as const, kind: "run" as const, id: "run-sonar-3", scope,
            configuration: { routineId: "sonar-fix-denied", revision: 1 as const },
            input: { kind: "input-reference" as const, id: "input-sonar-3" },
            mode: "live" as const, authority, state: { kind: "queued" as const }, actions: []
          }
          yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-sonar-3", run }] })
          const environment: AutomationWorkerEnvironment = {
            services: { configurations, credentials, executions, sql, http },
            registry, routines, decide: unusedDecide
          }
          const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-sonar-3")
          expect(outcome).toBe("failed")
          const stored = (yield* executions.getRun(scope, "run-sonar-3"))!
          expect(stored.value.state.kind).toBe("failed")
        })
        const Full = Layer.mergeAll(Live, NodeServices.layer)
        yield* program.pipe(Effect.provide(Full))
      } finally {
        sonarStub.close()
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
