import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, FileSystem, Layer } from "effect"
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
import { buildConflictPrompt, evaluateResolutionChecks, makeConflictConnectorExtension } from "../../automation/conflict-connector.js"
import type { ConflictConnectorServices } from "../../automation/conflict-connector.js"
import { buildPrConflictProcess } from "@expand/contracts/automation/conflicts"
import { DefaultAutomationWorkerOptions, processRun } from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { startGithubStub } from "../fixtures/automation-github-stub.js"

const scope = { ownerId: "conflict-owner", projectId: "conflict-project" }
const stubPath = fileURLToPath(new URL("../fixtures/automation-acp-stub.mjs", import.meta.url))
const tokenBytes = new TextEncoder().encode("conflict-github-token")

const conflictIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "conflicts",
  definition: { id: "github:pr-conflict-integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello", permittedBranches: ["feature/"], protectedBranches: ["develop", "master", "main"], defaultBranch: "develop" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "conflict-token" } }
}

const conflictAuthority = {
  schemaVersion: 1 as const,
  kind: "invocation-authority" as const,
  scope,
  configuration: { routineId: "conflicts", revision: 1 as const },
  integrationIds: ["conflicts"],
  actionGrants: [{ action: { id: "github:resolve-pr-conflict", version: 1 }, integrationId: "conflicts", capabilities: ["resolve"] }]
}

const setupLayers = () => {
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const registry = new AutomationRegistry()
  const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(Layer.provideMerge(Creds))
  return { registry, Live }
}

const unusedDecide: AutomationWorkerEnvironment["decide"] = () => Effect.fail({ code: "unused", message: "unused" }) as never
const readRoot = (fs: FileSystem.FileSystem, root: string) => fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)))

describe("automation pr conflicts", () => {
  it.effect("builds a worktree prompt and validates resolution checks", () =>
    Effect.gen(function*() {
      const prompt = buildConflictPrompt({ pullNumber: 7, headBranch: "feature/conflict-demo", baseBranch: "develop" })
      expect(prompt).toContain("feature/conflict-demo")
      expect(prompt).toContain("write:RESOLUTION.md:")
      expect(buildConflictPrompt({ pullNumber: 7, headBranch: "", baseBranch: "develop" })).toBe("")
      expect(evaluateResolutionChecks({ diffSummary: "", transcript: [], exitStatus: 0, headBranch: "feature/conflict-demo" }).passed).toBe(false)
      expect(evaluateResolutionChecks({ diffSummary: " RESOLUTION.md | 1 +", transcript: ["wrote RESOLUTION.md"], exitStatus: 0, headBranch: "feature/conflict-demo" }).passed).toBe(true)
    }))
  it.live("resolves a conflicted feature PR in an isolated worktree without touching protected branches", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "conflict-worktrees-" })
      const githubStub = yield* Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
      githubStub.setReply((call) => {
        if (call.method === "GET" && call.path === "/repos/octo/hello/pulls/7") {
          return { status: 200, body: { number: 7, title: "conflicted", head: { ref: "feature/conflict-demo", sha: "abc123" }, base: { ref: "develop", sha: "def456" }, mergeable: false, mergeable_state: "dirty" } }
        }
        return { status: 404, body: { message: "Not Found" } }
      })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: ConflictConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeConflictConnectorExtension(
          { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, githubOptions: { baseUrl: githubStub.baseUrl, timeoutMs: 5000, maxRetries: 0 } },
          services
        ).extension)
        yield* credentials.putCredential(scope, "conflict-token", tokenBytes, 0)
        const process = yield* buildPrConflictProcess("conflicts", conflictIntegration.configuration)
        yield* routines.create(scope, { routineId: "conflicts", configuration: conflictIntegration.configuration, integrations: [conflictIntegration], process })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-conflict-1",
          scope,
          integration: { id: "conflicts", definition: { id: "github:pr-conflict-integration" as const, version: 1 } },
          externalId: "input-conflict-1",
          trigger: { id: "github:pr-conflict" as const, version: 1 },
          payload: { pullNumber: 7, headBranch: "feature/conflict-demo", baseBranch: "develop", headSha: "abc123", mergeable: false }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-conflict-1",
          scope,
          configuration: { routineId: "conflicts", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-conflict-1" },
          mode: "live" as const,
          authority: conflictAuthority,
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-conflict-1", run }] })
        const environment: AutomationWorkerEnvironment = { services: { configurations, credentials, executions, sql, http }, registry, routines, decide: unusedDecide }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-conflict-1")
        expect(outcome).toBe("completed")
        const stored = (yield* executions.getRun(scope, "run-conflict-1"))!
        expect(stored.value.state.kind).toBe("succeeded")
        expect(githubStub.calls.some((call) => call.path === "/repos/octo/hello/pulls/7")).toBe(true)
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  it.live("records protected heads as unresolved without publishing changes", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "conflict-protected-" })
      const githubStub = yield* Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: ConflictConnectorServices = { configurations, credentials, http }
        yield* registry.register(makeConflictConnectorExtension(
          { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, githubOptions: { baseUrl: githubStub.baseUrl, timeoutMs: 5000, maxRetries: 0 } },
          services
        ).extension)
        yield* credentials.putCredential(scope, "conflict-token", tokenBytes, 0)
        const process = yield* buildPrConflictProcess("conflicts", conflictIntegration.configuration)
        yield* routines.create(scope, { routineId: "conflicts", configuration: conflictIntegration.configuration, integrations: [conflictIntegration], process })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-protected-1",
          scope,
          integration: { id: "conflicts", definition: { id: "github:pr-conflict-integration" as const, version: 1 } },
          externalId: "input-protected-1",
          trigger: { id: "github:pr-conflict" as const, version: 1 },
          payload: { pullNumber: 7, headBranch: "develop", baseBranch: "main", headSha: "abc123", mergeable: false }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-protected-1",
          scope,
          configuration: { routineId: "conflicts", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-protected-1" },
          mode: "live" as const,
          authority: conflictAuthority,
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-protected-1", run }] })
        const environment: AutomationWorkerEnvironment = { services: { configurations, credentials, executions, sql, http }, registry, routines, decide: unusedDecide }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-protected-1")
        expect(outcome).toBe("failed")
        expect(githubStub.calls.length).toBe(0)
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
