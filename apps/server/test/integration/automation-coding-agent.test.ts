import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Cause, Effect, Exit, Fiber, FileSystem, Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { runAcpPrompt } from "../../automation/acp-transport.js"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { makeCodingConnectorExtension, resetCodingAdaptersForTests } from "../../automation/coding-connector.js"
import type { CodingConnectorServices } from "../../automation/coding-connector.js"
import { clearCodingAdapters, executeCodingSession, makeStubAdapter, registerCodingAdapter, resolveCodingAdapter } from "../../automation/coding-agent.js"
import { DefaultAutomationWorkerOptions, processRun } from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"

const scope = { ownerId: "coding-owner", projectId: "coding-project" }
const stubPath = fileURLToPath(new URL("../fixtures/automation-acp-stub.mjs", import.meta.url))
const grandchildStubPath = fileURLToPath(new URL("../fixtures/automation-acp-grandchild-stub.mjs", import.meta.url))
const protocolStubPath = fileURLToPath(new URL("../fixtures/automation-acp-protocol-stub.mjs", import.meta.url))

const sampleIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "mail",
  definition: { id: "sample:mail" as const, version: 1 as const },
  configuration: { mailbox: "inbox" },
  credentials: {
    account: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "account-1" }
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

const codingProcess = {
  schemaVersion: 1 as const,
  kind: "process" as const,
  trigger: {
    definition: { id: "sample:received" as const, version: 1 as const },
    integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
    configuration: {}
  },
  actions: {
    triggered: [
      {
        id: "code",
        action: { id: "coding-agent:execute" as const, version: 1 as const },
        integration: { id: "coding", definition: { id: "coding-agent:integration" as const, version: 1 as const } },
        bindings: {
          prompt: { kind: "field" as const, source: "trigger" as const, path: ["subject"] },
          agentKind: { kind: "literal" as const, value: "opencode" },
          timeoutMs: { kind: "literal" as const, value: 8000 },
          requestedCapabilities: { kind: "literal" as const, value: ["execute"] }
        }
      }
    ]
  }
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

const unusedDecide: AutomationWorkerEnvironment["decide"] = () =>
  Effect.fail({ code: "unused", message: "unused" }) as never

const readRoot = (fs: FileSystem.FileSystem, root: string) =>
  fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)))

describe("automation coding agent", () => {
  it.live("executes real code via stub ACP child process and records transcript and diff", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "coding-worktrees-success-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: CodingConnectorServices = { configurations, credentials }
        yield* registry.register(makeSampleExtension().extension)
        yield* registry.register(
          makeCodingConnectorExtension(
            { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000 },
            services
          ).extension
        )
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret-1"), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("stub-token"), 0)
        yield* routines.create(scope, {
          routineId: "code",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration, codingIntegration],
          process: codingProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-code-1",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-code-1",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "write:OUTPUT.md:hello-from-stub", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-code-1",
          scope,
          configuration: { routineId: "code", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-code-1" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "code", revision: 1 as const },
            integrationIds: ["mail", "coding"],
            actionGrants: [{ action: { id: "coding-agent:execute", version: 1 }, integrationId: "coding", capabilities: ["execute"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-code-1", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1 }, scope, "run-code-1")
        expect(outcome).toBe("completed")
        const stored = (yield* executions.getRun(scope, "run-code-1"))!
        expect(stored.value.state.kind).toBe("succeeded")
        const history = (yield* executions.history(scope, "run-code-1"))!
        const completed = history.attempts.filter((entry) => entry.kind === "action" && entry.status === "completed")
        expect(completed.length).toBeGreaterThanOrEqual(1)
        const outcomeValue = (completed[0] as { outcome: { kind: string; result: unknown } }).outcome
        expect(outcomeValue.kind).toBe("succeeded")
        const result = outcomeValue.result as { transcript: Array<string>; diffSummary: string; exitStatus: number; agentKind: string }
        expect(result.agentKind).toBe("opencode")
        expect(result.exitStatus).toBe(0)
        expect(result.transcript.join("\n")).toContain("stub working")
        expect(result.diffSummary.length).toBeGreaterThan(0)
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("records timeout as failed with evidence and removes the worktree", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "coding-worktrees-timeout-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: CodingConnectorServices = { configurations, credentials }
        yield* registry.register(makeSampleExtension().extension)
        yield* registry.register(
          makeCodingConnectorExtension(
            { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 400 },
            services
          ).extension
        )
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret-1"), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("stub-token"), 0)
        const timeoutProcess = {
          ...codingProcess,
          actions: {
            triggered: [
              {
                id: "code",
                action: { id: "coding-agent:execute" as const, version: 1 as const },
                integration: { id: "coding", definition: { id: "coding-agent:integration" as const, version: 1 as const } },
                bindings: {
                  prompt: { kind: "literal" as const, value: "sleep:5000" },
                  agentKind: { kind: "literal" as const, value: "opencode" },
                  timeoutMs: { kind: "literal" as const, value: 400 },
                  requestedCapabilities: { kind: "literal" as const, value: ["execute"] }
                }
              }
            ]
          }
        }
        yield* routines.create(scope, {
          routineId: "code-timeout",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration, codingIntegration],
          process: timeoutProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-timeout-1",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-timeout-1",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-timeout-1",
          scope,
          configuration: { routineId: "code-timeout", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-timeout-1" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "code-timeout", revision: 1 as const },
            integrationIds: ["mail", "coding"],
            actionGrants: [{ action: { id: "coding-agent:execute", version: 1 }, integrationId: "coding", capabilities: ["execute"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-timeout-1", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 8000, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-timeout-1")
        expect(outcome).toBe("failed")
        const stored = (yield* executions.getRun(scope, "run-timeout-1"))!
        expect(stored.value.state.kind).toBe("failed")
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("kills the session on interruption and removes the worktree", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "coding-worktrees-cancel-" })
      registerCodingAdapter(makeStubAdapter("node", [stubPath], "opencode"))
      const fiber = yield* executeCodingSession(worktreeRoot, {
        runId: "cancel-1",
        repository: "octo/hello",
        prompt: "sleep:5000",
        agentKind: "opencode",
        requestedCapabilities: ["execute"],
        timeoutMs: 8000,
        tokenEnv: {}
      }).pipe(Effect.forkChild)
      yield* Effect.sleep("300 millis")
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("enforces action grants, credentials by reference, and capability negotiation", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "coding-worktrees-grants-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: CodingConnectorServices = { configurations, credentials }
        yield* registry.register(makeSampleExtension().extension)
        yield* registry.register(
          makeCodingConnectorExtension(
            { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 2000 },
            services
          ).extension
        )
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret-1"), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("stub-token"), 0)
        yield* routines.create(scope, {
          routineId: "code-denied",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration, codingIntegration],
          process: codingProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-denied-1",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-denied-1",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "write:OUTPUT.md:nope", count: "2" }
        }
        const deniedRun = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-denied-1",
          scope,
          configuration: { routineId: "code-denied", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-denied-1" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "code-denied", revision: 1 as const },
            integrationIds: ["mail", "coding"],
            actionGrants: []
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-denied-1", run: deniedRun }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-denied-1")
        expect(outcome).toBe("failed")
        expect((yield* executions.getRun(scope, "run-denied-1"))?.value.state.kind).toBe("failed")
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
        const unknown = yield* Effect.exit(resolveCodingAdapter("unknown-kind", ["execute"]))
        expect(unknown._tag).toBe("Failure")
        const unsupported = yield* Effect.exit(resolveCodingAdapter("opencode", ["nonexistent-capability"]))
        expect(unsupported._tag).toBe("Failure")
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
  it.live("kills grandchildren with the process group on timeout", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "coding-acp-group-" })
      const pidFile = `${dir}/grandchild.pid`
      const exit = yield* Effect.exit(runAcpPrompt({ command: "node", args: [grandchildStubPath], cwd: dir, env: { GRANDCHILD_PID_FILE: pidFile } }, { prompt: "hello", timeoutMs: 400 }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const failure = Cause.squash(exit.cause) as { code: string; transcript?: ReadonlyArray<string>; durationMs?: number }
      expect(failure.code).toBe("timeout")
      expect(failure.transcript?.length).toBeGreaterThan(0)
      expect(failure.durationMs).toBeDefined()
      const pidText = yield* fs.readFileString(pidFile)
      const pid = Number(pidText.trim())
      expect(Number.isSafeInteger(pid)).toBe(true)
      expect(pid).toBeGreaterThan(0)
      const check = spawnSync("kill", ["-0", `${pid}`])
      expect(check.status).not.toBe(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("preserves timeout evidence through coding error", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "coding-evidence-timeout-" })
      registerCodingAdapter(makeStubAdapter("node", [stubPath], "opencode"))
      const sessionExit = yield* Effect.exit(executeCodingSession(worktreeRoot, {
        runId: "evidence-timeout-1",
        repository: "octo/hello",
        prompt: "sleep:5000",
        agentKind: "opencode",
        requestedCapabilities: ["execute"],
        timeoutMs: 400,
        tokenEnv: {}
      }))
      expect(Exit.isFailure(sessionExit)).toBe(true)
      if (!Exit.isFailure(sessionExit)) return
      const codingError = Cause.squash(sessionExit.cause) as { code: string; transcript?: ReadonlyArray<string>; durationMs?: number; exitStatus?: number }
      expect(codingError.code).toBe("timeout")
      expect(codingError.transcript).toBeDefined()
      expect((codingError.transcript ?? []).length).toBeGreaterThan(0)
      expect(codingError.durationMs).toBeDefined()
      expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live("preserves protocol evidence into failure details", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "coding-evidence-protocol-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: CodingConnectorServices = { configurations, credentials }
        const codingExtension = makeCodingConnectorExtension(
          { worktreeRoot, agentCommand: "node", agentArgs: [protocolStubPath], defaultTimeoutMs: 2000 },
          services
        )
        yield* registry.register(makeSampleExtension().extension)
        yield* registry.register(codingExtension.extension)
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret-1"), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("stub-token"), 0)
        yield* routines.create(scope, {
          routineId: "code-protocol",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration, codingIntegration],
          process: codingProcess
        })
        const installed = codingExtension.extension.actions[0]!
        const context = { scope, routineId: "code-protocol", configurationRevision: 1, integrationId: "coding", mode: "live" as const }
        const args = { prompt: "hello", agentKind: "opencode", timeoutMs: 2000, requestedCapabilities: ["execute"] }
        const configuration = { repository: "octo/hello" }
        const invoked = yield* Effect.exit(installed.invoke(args, configuration, context))
        expect(Exit.isFailure(invoked)).toBe(true)
        if (!Exit.isFailure(invoked)) return
        const automationError = Cause.squash(invoked.cause) as { code: string; failure?: { code: string; message: string; details?: unknown } }
        expect(automationError.failure).toBeDefined()
        const details = automationError.failure?.details as { transcript?: Array<string>; durationMs?: number; exitStatus?: number } | undefined
        expect(details).toBeDefined()
        expect(details?.transcript).toBeDefined()
        expect((details?.transcript ?? []).length).toBeGreaterThan(0)
        expect(details?.durationMs).toBeDefined()
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
        void executions
        void sql
        void http
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
