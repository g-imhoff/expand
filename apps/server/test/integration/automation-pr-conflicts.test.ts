import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, FileSystem, Layer } from "effect"
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
import { clearCodingAdapters, registerCodingAdapter } from "../../automation/coding-agent.js"
import { makeConflictConnectorExtension } from "../../automation/conflict-connector.js"
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
  it.live("records resolution as unavailable without running a marker-only agent or creating a worktree", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "conflict-worktrees-" })
      let agentCalls = 0
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
        registerCodingAdapter({
          kind: "opencode",
          capabilities: ["execute"],
          spawn: (input) => Effect.gen(function*() {
            agentCalls += 1
            yield* fs.writeFileString(`${input.worktree}/RESOLUTION.md`, "resolved feature/conflict-demo pr 7")
            return { sessionId: "marker-only", transcript: ["wrote RESOLUTION.md"], exitStatus: 0, durationMs: 1 }
          }).pipe(Effect.orDie)
        })
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
        expect(stored.value.actions).toHaveLength(1)
        expect(stored.value.actions[0]).toMatchObject({
          kind: "succeeded",
          result: { resolved: false, reason: "resolution-unavailable:verified-repository-worktree-required" }
        })
        expect(agentCalls).toBe(0)
        expect(githubStub.calls.some((call) => call.path === "/repos/octo/hello/pulls/7")).toBe(true)
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  it.live("rechecks the current PR and rejects changed refs before reporting resolution unavailable", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "conflict-current-pr-" })
      const githubStub = yield* Effect.acquireRelease(startGithubStub(), (stub) => Effect.sync(() => stub.close()))
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const http = yield* HttpClient.HttpClient
        const connector = makeConflictConnectorExtension(
          { worktreeRoot, agentCommand: "expand-agent-must-not-run", agentArgs: [], defaultTimeoutMs: 8000, githubOptions: { baseUrl: githubStub.baseUrl, timeoutMs: 5000, maxRetries: 0 } },
          { configurations, credentials, http }
        )
        yield* registry.register(connector.extension)
        yield* credentials.putCredential(scope, "conflict-token", tokenBytes, 0)
        const process = yield* buildPrConflictProcess("conflicts", conflictIntegration.configuration)
        yield* routines.create(scope, { routineId: "conflicts", configuration: conflictIntegration.configuration, integrations: [conflictIntegration], process })
        const installed = connector.extension.actions[0]!
        const args = { pullNumber: 7, headBranch: "feature/conflict-demo", baseBranch: "develop", expectedHeadSha: "abc123" }
        const context = { scope, routineId: "conflicts", configurationRevision: 1, integrationId: "conflicts", mode: "live" as const }
        const cases = [
          { headSha: "moved123", headBranch: "feature/conflict-demo", baseBranch: "develop", mergeable: false, message: "unvalidated:head moved" },
          { headSha: "abc123", headBranch: "feature/other", baseBranch: "develop", mergeable: false, message: "unvalidated:branches moved" },
          { headSha: "abc123", headBranch: "feature/conflict-demo", baseBranch: "main", mergeable: false, message: "unvalidated:branches moved" },
          { headSha: "abc123", headBranch: "feature/conflict-demo", baseBranch: "develop", mergeable: true, reason: "not-conflicted" },
          { headSha: "abc123", headBranch: "feature/conflict-demo", baseBranch: "develop", mergeable: false, reason: "resolution-unavailable:verified-repository-worktree-required" }
        ]
        for (const check of cases) {
          githubStub.setReply(() => ({
            status: 200,
            body: { number: 7, title: "current PR", head: { ref: check.headBranch, sha: check.headSha }, base: { ref: check.baseBranch, sha: "def456" }, mergeable: check.mergeable, mergeable_state: check.mergeable ? "clean" : "dirty" }
          }))
          const result = yield* Effect.exit(installed.invoke(args, conflictIntegration.configuration, context))
          if (check.message !== undefined) {
            expect(Exit.isFailure(result)).toBe(true)
            if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toMatchObject({ failure: { code: "check-failed", message: check.message, details: { resolved: false } } })
          } else {
            expect(Exit.isSuccess(result)).toBe(true)
            if (Exit.isSuccess(result)) expect(result.value).toEqual({ resolved: false, reason: check.reason })
          }
        }
        expect(githubStub.calls).toHaveLength(cases.length)
        expect(githubStub.calls.every((call) => call.method === "GET" && call.path === "/repos/octo/hello/pulls/7")).toBe(true)
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      yield* program.pipe(Effect.provide(Layer.mergeAll(Live, NodeServices.layer)))
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
