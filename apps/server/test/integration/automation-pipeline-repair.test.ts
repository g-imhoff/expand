import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { fileURLToPath } from "node:url"
import { it } from "@effect/vitest"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { defineExtension } from "@expand/contracts/automation"
import { codingIntegrationDefinition } from "@expand/contracts/automation/coding"
import { githubIntegrationDefinition } from "@expand/contracts/automation/github"
import {
  PipelineRepairResult,
  pipelineIntegrationReference,
  pipelineRepairActionReference,
  pipelineTriggerReference
} from "@expand/contracts/automation/pipeline"
import {
  makePipelineRepairExtension,
  resetPipelineRepairAttemptsForTests
} from "../../automation/pipeline-repair.js"
import type { SkillDefinition } from "../../automation/skill-registry.js"
import { clearCodingAdapters } from "../../automation/coding-agent.js"
import { resetCodingAdaptersForTests } from "../../automation/coding-connector.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"
import { Schema } from "effect"

const scope = { ownerId: "pipeline-owner", projectId: "pipeline-project" }
const stubPath = fileURLToPath(new URL("../fixtures/automation-acp-stub.mjs", import.meta.url))
const githubToken = "stub-pipeline-github-token"
const codingToken = "stub-pipeline-coding-token"

const RepairInput = Schema.Struct({
  runId: Schema.Int.check(Schema.isGreaterThan(0)),
  owner: Schema.String.check(Schema.isMinLength(1)),
  repo: Schema.String.check(Schema.isMinLength(1)),
  branch: Schema.String.check(Schema.isMinLength(1)),
  sha: Schema.String.check(Schema.isMinLength(1)),
  workflow: Schema.String.check(Schema.isMinLength(1)),
  logsSnippet: Schema.String.check(Schema.isMinLength(1))
})

const repairSkill: SkillDefinition = {
  id: "pipeline-repair-test",
  version: 1,
  title: "Pipeline repair test",
  description: "Repairs the sandbox workflow",
  inputSchema: RepairInput,
  requiredCapabilities: ["execute"],
  allowedPaths: ["REPAIR.md"],
  buildPrompt: (inputs) => {
    const record = inputs as { readonly runId?: unknown; readonly branch?: unknown }
    const runId = typeof record.runId === "number" ? record.runId : 0
    const branch = typeof record.branch === "string" ? record.branch : "sandbox"
    const single = `${branch}-${runId}`.split("\n")[0] ?? "repair"
    return [
      "You are a pipeline repair skill. Make exactly one change.",
      `write:REPAIR.md:${single}`,
      "Only modify REPAIR.md. Do not touch any other file.",
      "Do not print secrets or tokens in the transcript.",
      "When done, report wrote REPAIR.md."
    ].join("\n")
  }
}

const rogueSkill: SkillDefinition = {
  id: "pipeline-rogue-test",
  version: 1,
  title: "Pipeline rogue test",
  description: "Edits outside allowed paths",
  inputSchema: RepairInput,
  requiredCapabilities: ["execute"],
  allowedPaths: ["REPAIR.md"],
  buildPrompt: () => [
    "write:UNRELATED.md:rogue",
    "Report wrote UNRELATED.md."
  ].join("\n")
}

const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {
    token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" }
  }
}

const codingIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "coding",
  definition: { id: "coding-agent:integration" as const, version: 1 as const },
  configuration: { repository: "octo/hello" },
  credentials: {
    token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "coding-token" }
  }
}

const pipelineIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "pipeline",
  definition: { id: "pipeline:integration" as const, version: 1 as const },
  configuration: {
    repairSkillId: "pipeline-repair-test",
    githubIntegrationId: "github",
    codingIntegrationId: "coding",
    maxAttempts: 2,
    protectedBranches: ["develop", "master", "main"],
    allowedBranches: ["feature/repair-sandbox"],
    requireDraft: true
  },
  credentials: {}
}

const bindingsFor = {
  runId: { kind: "field" as const, source: "trigger" as const, path: ["runId"] },
  owner: { kind: "field" as const, source: "trigger" as const, path: ["owner"] },
  repo: { kind: "field" as const, source: "trigger" as const, path: ["repo"] },
  branch: { kind: "field" as const, source: "trigger" as const, path: ["branch"] },
  sha: { kind: "field" as const, source: "trigger" as const, path: ["sha"] },
  workflow: { kind: "field" as const, source: "trigger" as const, path: ["workflow"] }
}

const repairProcess = {
  schemaVersion: 1 as const,
  kind: "process" as const,
  trigger: {
    definition: { ...pipelineTriggerReference },
    integration: { id: "pipeline", definition: { ...pipelineIntegrationReference } },
    configuration: {}
  },
  actions: {
    triggered: [
      {
        id: "repair-1",
        action: { ...pipelineRepairActionReference },
        integration: { id: "pipeline", definition: { ...pipelineIntegrationReference } },
        bindings: bindingsFor
      }
    ]
  }
}

const repairAuthority = {
  schemaVersion: 1 as const,
  kind: "invocation-authority" as const,
  scope,
  configuration: { routineId: "pipeline-repair", revision: 1 as const },
  integrationIds: ["pipeline", "github", "coding"],
  actionGrants: [
    { action: { ...pipelineRepairActionReference }, integrationId: "pipeline", capabilities: ["repair"] }
  ]
}

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

const withStub = Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))

describe("pipeline repair", () => {
  it.live("repairs a failed run in the authorized sandbox and blocks protected branches, duplicates, and unvalidated retries", () =>
    Effect.gen(function*() {
      resetPipelineRepairAttemptsForTests()
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const stub = yield* withStub
      stub.setReply((call) => {
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/42") {
          return { status: 200, body: { id: 42, head_branch: "feature/repair-sandbox", head_sha: "abc123", conclusion: "failure", name: "ci", html_url: null } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/42/logs") {
          return { status: 200, body: "failure log line" }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/43") {
          return { status: 200, body: { id: 43, head_branch: "feature/repair-sandbox", head_sha: "def456", conclusion: "failure", name: "ci", html_url: null } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/43/logs") {
          return { status: 200, body: "rogue failure log" }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/44") {
          return { status: 200, body: { id: 44, head_branch: "feature/other", head_sha: "abc123", conclusion: "failure", name: "ci", html_url: null } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/44/logs") {
          return { status: 200, body: "mismatch log" }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/45") {
          return { status: 200, body: { id: 45, head_branch: "feature/repair-sandbox", head_sha: "abc123", conclusion: "success", name: "ci", html_url: null } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/45/logs") {
          return { status: 200, body: "success log" }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/46") {
          return { status: 200, body: { id: 46, head_branch: "feature/repair-sandbox", head_sha: "abc123", conclusion: "failure", name: "ci", html_url: null } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/46/logs") {
          return { status: 500, body: { message: "upstream" } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/47") {
          return { status: 200, body: { id: 47, head_branch: "feature/repair-sandbox", head_sha: "abc123", conclusion: "failure", name: "ci", html_url: null } }
        }
        if (call.method === "GET" && call.path === "/repos/octo/hello/actions/runs/47/logs") {
          return { status: 200, body: "real fetched log" }
        }
        return { status: 404, body: { message: "Not Found" } }
      })
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pipeline-repair-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        void sql
        yield* registry.register(defineExtension({ integrations: [githubIntegrationDefinition], triggers: [], actions: [], routines: [] }))
        yield* registry.register(defineExtension({ integrations: [codingIntegrationDefinition], triggers: [], actions: [], routines: [] }))
        yield* registry.register(
          makePipelineRepairExtension(
            {
              skills: [repairSkill, rogueSkill],
              worktreeRoot,
              agentCommand: "node",
              agentArgs: [stubPath],
              defaultTimeoutMs: 15000,
              githubOptions: { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
            },
            { configurations, credentials, http }
          ).extension
        )
        yield* credentials.putCredential(scope, "github-token", new TextEncoder().encode(githubToken), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode(codingToken), 0)
        const routineConfiguration = {
          schemaVersion: 1 as const,
          kind: "routine-configuration" as const,
          reference: { routineId: "pipeline-repair", revision: 1 as const },
          scope,
          configuration: {},
          integrations: [pipelineIntegration, githubIntegration, codingIntegration],
          process: repairProcess
        }
        yield* routines.create(scope, {
          routineId: "pipeline-repair",
          configuration: {},
          integrations: [pipelineIntegration, githubIntegration, codingIntegration],
          process: repairProcess
        })
        const triggerPayload = {
          runId: 42,
          owner: "octo",
          repo: "hello",
          branch: "feature/repair-sandbox",
          sha: "abc123",
          workflow: "ci",
          conclusion: "failure" as const
        }
        const first = yield* registry.invokeAction(
          { configuration: routineConfiguration, stepId: "repair-1", triggerPayload, mode: "live" },
          repairAuthority
        )
        const repaired = yield* Schema.decodeUnknownEffect(PipelineRepairResult, { onExcessProperty: "error" })(first)
        expect(repaired.repaired).toBe(true)
        expect(repaired.runId).toBe(42)
        expect(repaired.branch).toBe("feature/repair-sandbox")
        expect(repaired.skillId).toBe("pipeline-repair-test")
        expect(repaired.checks.every((check: { passed: boolean }) => check.passed)).toBe(true)
        expect(repaired.draftPr?.draft).toBe(true)
        expect(repaired.draftPr?.base).toBe("feature/repair-sandbox")
        const flat = [...repaired.checks.map((check: { check: string }) => check.check)].join("\n")
        expect(flat).toContain("exit-zero")
        const duplicate = yield* registry.invokeAction(
          { configuration: routineConfiguration, stepId: "repair-1", triggerPayload, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(duplicate.code).toBe("handler-failed")
        expect(duplicate.failure?.code ?? duplicate.code).toBe("duplicate")
        const protectedPayload = { ...triggerPayload, branch: "develop", sha: "zzz999" }
        const blocked = yield* registry.invokeAction(
          { configuration: routineConfiguration, stepId: "repair-1", triggerPayload: protectedPayload, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(blocked.code).toBe("handler-failed")
        expect(blocked.failure?.code ?? blocked.code).toBe("protected-branch")
        const rogueIntegration = {
          ...pipelineIntegration,
          id: "pipeline",
          configuration: { ...pipelineIntegration.configuration, repairSkillId: "pipeline-rogue-test", maxAttempts: 1 }
        }
        yield* configurations.putIntegration(scope, rogueIntegration, 1)
        const roguePayload = {
          runId: 43,
          owner: "octo",
          repo: "hello",
          branch: "feature/repair-sandbox",
          sha: "def456",
          workflow: "ci",
          conclusion: "failure" as const
        }
        const unvalidated = yield* registry.invokeAction(
          { configuration: { ...routineConfiguration, integrations: [rogueIntegration, githubIntegration, codingIntegration] }, stepId: "repair-1", triggerPayload: roguePayload, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(unvalidated.code).toBe("handler-failed")
        expect(unvalidated.failure?.code ?? unvalidated.code).toBe("check-failed")
        const exhausted = yield* registry.invokeAction(
          { configuration: { ...routineConfiguration, integrations: [rogueIntegration, githubIntegration, codingIntegration] }, stepId: "repair-1", triggerPayload: roguePayload, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(exhausted.code).toBe("handler-failed")
        expect(exhausted.failure?.code ?? exhausted.code).toBe("retry-exhausted")
        yield* configurations.putIntegration(scope, pipelineIntegration, 2)
        const liveConfiguration = { ...routineConfiguration, integrations: [pipelineIntegration, githubIntegration, codingIntegration] }
        const mismatch = yield* registry.invokeAction(
          { configuration: liveConfiguration, stepId: "repair-1", triggerPayload: { ...triggerPayload, runId: 44 }, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(mismatch.code).toBe("handler-failed")
        expect(mismatch.failure?.code ?? mismatch.code).toBe("invalid-contract")
        const succeededRun = yield* registry.invokeAction(
          { configuration: liveConfiguration, stepId: "repair-1", triggerPayload: { ...triggerPayload, runId: 45 }, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(succeededRun.code).toBe("handler-failed")
        expect(succeededRun.failure?.code ?? succeededRun.code).toBe("invalid-contract")
        const logFailed = yield* registry.invokeAction(
          { configuration: liveConfiguration, stepId: "repair-1", triggerPayload: { ...triggerPayload, runId: 46 }, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(logFailed.code).toBe("handler-failed")
        expect(logFailed.failure?.code ?? logFailed.code).toBe("log-fetch")
        const deniedBranch = yield* registry.invokeAction(
          { configuration: liveConfiguration, stepId: "repair-1", triggerPayload: { ...triggerPayload, runId: 47, branch: "feature/not-allowed" }, mode: "live" },
          repairAuthority
        ).pipe(Effect.flip)
        expect(deniedBranch.code).toBe("handler-failed")
        expect(deniedBranch.failure?.code ?? deniedBranch.code).toBe("branch-not-allowed")
        const fetchedOnly = yield* registry.invokeAction(
          { configuration: liveConfiguration, stepId: "repair-1", triggerPayload: { ...triggerPayload, runId: 47 }, mode: "live" },
          repairAuthority
        )
        const fetchedDecoded = yield* Schema.decodeUnknownEffect(PipelineRepairResult, { onExcessProperty: "error" })(fetchedOnly)
        expect(fetchedDecoded.repaired).toBe(true)
        expect(fetchedDecoded.runId).toBe(47)
        const delivery = {
          schemaVersion: 1 as const,
          id: "pipeline-delivery-42",
          scope,
          integration: { id: "pipeline", definition: { ...pipelineIntegrationReference } },
          externalId: "octo/hello#42",
          trigger: { ...pipelineTriggerReference },
          payload: triggerPayload
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "pipeline-run-42",
          scope,
          configuration: { routineId: "pipeline-repair", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "pipeline-delivery-42" },
          mode: "live" as const,
          authority: repairAuthority,
          state: { kind: "queued" as const },
          actions: []
        }
        const acceptedFirst = yield* executions.ingest({ delivery, raw: new TextEncoder().encode("pipeline-42"), targets: [{ jobId: "pipeline-job-42", run }] })
        const acceptedSecond = yield* executions.ingest({ delivery, raw: new TextEncoder().encode("pipeline-42"), targets: [{ jobId: "pipeline-job-42", run }] })
        expect(acceptedSecond).toEqual(acceptedFirst)
        expect(yield* FileSystem.FileSystem.pipe(Effect.andThen(() => Effect.succeed(true)))).toBe(true)
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
