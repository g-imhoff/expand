import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { AutomationWorker, AutomationWorkerLayer } from "../../automation/worker.js"
import { makeCodingServerExtension } from "../../automation/coding-extension.js"
import { makeCodingAdapter } from "../../automation/coding-agent.js"
import type { CodingError, CodingProgressEvent } from "../../automation/coding-agent.js"
import { runCodingSession } from "../../automation/coding-session.js"
import { runProcessCommand } from "../../automation/coding-worktree.js"
import { spawnAcpProcess } from "../../automation/acp-transport.js"
import type { AcpHandle } from "../../automation/acp-transport.js"
import {
  codingActionReference, codingIntegrationReference, codingTriggerReference
} from "@expand/contracts/automation"

const scope = { ownerId: "coding-owner", projectId: "coding-project" }
const fakeSecret = "s3cr3t-value"
const fixturePath = join(globalThis.process.cwd(), "apps/server/test/fixtures/automation-coding-stub-agent.mjs")
const stubCommand = (mode: string): ReadonlyArray<string> => [globalThis.process.execPath, fixturePath, mode]

const sandboxRepo = Effect.gen(function*() {
  const root = yield* Effect.tryPromise(() => mkdtemp(join(tmpdir(), "coding-sandbox-")))
  const repo = join(root, "repo")
  yield* Effect.tryPromise(() => mkdir(repo, { recursive: true }))
  for (const args of [
    ["init"],
    ["config", "user.email", "coding@test.invalid"],
    ["config", "user.name", "Coding Test"]
  ]) {
    const settled = yield* runProcessCommand("git", args, repo)
    expect(settled.code).toBe(0)
  }
  yield* Effect.tryPromise(() => writeFile(join(repo, "README.md"), "base\n"))
  const added = yield* runProcessCommand("git", ["add", "README.md"], repo)
  expect(added.code).toBe(0)
  const committed = yield* runProcessCommand("git", ["commit", "-m", "init"], repo)
  expect(committed.code).toBe(0)
  return { root, repo, worktrees: join(root, "worktrees") }
})

const worktreeEntries = (root: string) => Effect.tryPromise(() => readdir(root)).pipe(Effect.orElseSucceed(() => []))

const codingBranches = (repo: string) => Effect.gen(function*() {
  const listed = yield* runProcessCommand("git", ["branch", "--list", "coding/*"], repo)
  expect(listed.code).toBe(0)
  return listed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
})

describe("coding session runner", () => {
  it.live("completes a trivial repo task in an isolated worktree with a real child process", () =>
    Effect.gen(function*() {
      const sandbox = yield* sandboxRepo
      const events = yield* Queue.unbounded<CodingProgressEvent>()
      const result = yield* runCodingSession({
        adapter: makeCodingAdapter("stub", stubCommand("complete")),
        worktreeRoot: sandbox.worktrees,
        repository: sandbox.repo,
        task: "create hello.txt",
        allowedActions: ["read", "edit"],
        env: {},
        secrets: [],
        deadlineMs: 30000,
        progress: events
      })
      expect(result.agent).toBe("stub")
      expect(result.exitStatus).toBe(0)
      expect(result.sessionId).toBe("stub-session-1")
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
      expect(result.filesChanged).toEqual(["hello.txt"])
      expect(result.diffSummary).toContain("hello.txt")
      expect(result.transcript.join("\n")).toContain("allowed:read,edit")
      expect(result.transcript.join("\n")).toContain("edited:hello.txt")
      const streamed = yield* Queue.takeAll(events)
      expect(streamed.length).toBeGreaterThan(0)
      expect(streamed.map((event) => event.text).join("\n")).toContain("edited:hello.txt")
      const mainFiles = yield* worktreeEntries(sandbox.repo)
      expect(mainFiles).not.toContain("hello.txt")
      expect(yield* worktreeEntries(sandbox.worktrees)).toEqual([])
      expect(yield* codingBranches(sandbox.repo)).toHaveLength(1)
    }))
  it.live("cancels a running session, kills the child and cleans the worktree", () =>
    Effect.gen(function*() {
      const sandbox = yield* sandboxRepo
      const events = yield* Queue.unbounded<CodingProgressEvent>()
      const cancel = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(runCodingSession({
        adapter: makeCodingAdapter("stub", stubCommand("hang")),
        worktreeRoot: sandbox.worktrees,
        repository: sandbox.repo,
        task: "never finishes",
        allowedActions: ["read", "edit"],
        env: {},
        secrets: [],
        deadlineMs: 30000,
        progress: events,
        cancel
      }))
      const first = yield* Queue.take(events)
      expect(first.text.length).toBeGreaterThan(0)
      yield* Deferred.succeed(cancel, undefined)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause) as CodingError
        expect(failure.code).toBe("cancelled")
      }
      expect(yield* worktreeEntries(sandbox.worktrees)).toEqual([])
      const mainFiles = yield* worktreeEntries(sandbox.repo)
      expect(mainFiles).not.toContain("hello.txt")
    }))
  it.live("times out a stuck session and records evidence instead of success", () =>
    Effect.gen(function*() {
      const sandbox = yield* sandboxRepo
      const exit = yield* Effect.exit(runCodingSession({
        adapter: makeCodingAdapter("stub", stubCommand("hang")),
        worktreeRoot: sandbox.worktrees,
        repository: sandbox.repo,
        task: "never finishes",
        allowedActions: ["read"],
        env: {},
        secrets: [],
        deadlineMs: 3000
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = Cause.squash(exit.cause) as CodingError
        expect(failure.code).toBe("timeout")
        const details = failure.details as { readonly transcriptTail: ReadonlyArray<string> }
        expect(details.transcriptTail.join("\n")).toContain("allowed:read")
      }
      expect(yield* worktreeEntries(sandbox.worktrees)).toEqual([])
    }))
})

describe("coding opencode compatibility", () => {
  it.live("drives initialize and session open against the real opencode binary", () =>
    Effect.gen(function*() {
      const probe = yield* Effect.result(runProcessCommand("opencode", ["--version"], globalThis.process.cwd()))
      if (Result.isFailure(probe) || probe.success.code !== 0) return
      const cwd = yield* Effect.tryPromise(() => mkdtemp(join(tmpdir(), "coding-opencode-")))
      yield* Effect.gen(function*() {
        const handle = yield* Effect.acquireRelease(
          spawnAcpProcess(["opencode", "acp"], cwd, { ...globalThis.process.env as Record<string, string> }),
          (open) => open.kill
        )
        yield* handle.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } })
        const hello = yield* awaitId(handle, 1)
        const parsed = yield* Schema.decodeUnknownEffect(HelloResult)(hello)
        expect(parsed.agentInfo.name).toBe("OpenCode")
        yield* handle.write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } })
        const opened = yield* awaitId(handle, 2)
        const session = yield* Schema.decodeUnknownEffect(SessionResult)(opened)
        expect(session.sessionId.length).toBeGreaterThan(0)
      }).pipe(Effect.scoped)
    }))
})

const HelloResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  agentCapabilities: Schema.Unknown,
  agentInfo: Schema.Struct({ name: Schema.String })
})
const SessionResult = Schema.Struct({ sessionId: Schema.String.check(Schema.isMinLength(1)) })
const awaitId = Effect.fn("Test.awaitId")(function*(handle: AcpHandle, id: number) {
  while (true) {
    const envelope = yield* handle.take
    if (envelope.id === id) return envelope.result
  }
})

describe("coding worker end to end", () => {
  it.live("records transcript, diff and exit status on the run with credentials by reference", () =>
    Effect.gen(function*() {
      const sandbox = yield* sandboxRepo
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeCodingServerExtension({ commands: { stub: stubCommand("complete") } }).extension)
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(Configs, Creds)))
      const Worker = AutomationWorkerLayer(registry, {
        maxAttempts: 1, baseBackoffMs: 1, attemptTimeoutMs: 30000, pollBatchSize: 10, concurrency: 1, pollIntervalMs: 10, jev: {}
      }).pipe(Layer.provide(Layer.mergeAll(Execs, Configs, Creds, Routines, NodeHttpClient.layerFetch)))
      const Services = Layer.mergeAll(Ready, Configs, Creds, Execs, Routines, Worker, NodeHttpClient.layerFetch)
      yield* Effect.gen(function*() {
        const configs = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        yield* credentials.putCredential(scope, "agent-token", fakeSecret, 0)
        yield* configs.putIntegration(scope, {
          schemaVersion: 1,
          kind: "integration-configuration",
          id: "repo",
          definition: codingIntegrationReference,
          configuration: { allowedRepositories: [sandbox.repo], agent: "stub", worktreeRoot: sandbox.worktrees, defaultDeadlineMs: 20000 },
          credentials: {}
        }, 0)
        yield* configs.appendRoutineRevision({
          schemaVersion: 1,
          kind: "routine-configuration",
          reference: { routineId: "coding", revision: 1 },
          scope,
          configuration: {},
          integrations: [{
            schemaVersion: 1,
            kind: "integration-configuration",
            id: "repo",
            definition: codingIntegrationReference,
            configuration: { allowedRepositories: [sandbox.repo], agent: "stub", worktreeRoot: sandbox.worktrees, defaultDeadlineMs: 20000 },
            credentials: {}
          }],
          process: {
            schemaVersion: 1,
            kind: "process",
            trigger: {
              definition: codingTriggerReference,
              integration: { id: "repo", definition: codingIntegrationReference },
              configuration: {}
            },
            actions: {
              triggered: [{
                id: "code",
                action: codingActionReference,
                integration: { id: "repo", definition: codingIntegrationReference },
                bindings: {
                  repository: { kind: "literal", value: sandbox.repo },
                  task: { kind: "field", source: "trigger", path: ["task"] },
                  allowedActions: { kind: "literal", value: ["read", "edit"] },
                  credentials: {
                    kind: "literal",
                    value: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "agent-token" } }
                  }
                }
              }]
            }
          }
        }, 0, "enabled")
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "coding-run",
          scope,
          configuration: { routineId: "coding", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "coding-delivery" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "coding", revision: 1 as const },
            integrationIds: ["repo"],
            actionGrants: [{ action: codingActionReference, integrationId: "repo", capabilities: ["code"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({
          delivery: {
            schemaVersion: 1 as const,
            id: "coding-delivery",
            scope,
            integration: { id: "repo", definition: codingIntegrationReference },
            externalId: "coding-external",
            trigger: codingTriggerReference,
            payload: { task: "create hello.txt" }
          },
          raw: new Uint8Array([9]),
          targets: [{ jobId: "coding-job", run }]
        })
        yield* worker.processRun(scope, "coding-run")
        const history = (yield* executions.history(scope, "coding-run"))!
        expect(history.run.value.state.kind).toBe("succeeded")
        expect(history.run.value.actions).toHaveLength(1)
        const outcome = history.run.value.actions[0]!
        expect(outcome.kind).toBe("succeeded")
        if (outcome.kind === "succeeded") {
          const result = outcome.result as {
            readonly sessionId: string; readonly exitStatus: number;
            readonly transcript: ReadonlyArray<string>; readonly diffSummary: string; readonly filesChanged: ReadonlyArray<string>
          }
          expect(result.exitStatus).toBe(0)
          expect(result.filesChanged).toEqual(["hello.txt"])
          expect(result.diffSummary).toContain("hello.txt")
          expect(result.transcript.join("\n")).toContain("credentialBytes:12")
          const recorded = `${result.transcript.join("\n")}\n${result.diffSummary}\n${result.filesChanged.join("\n")}`
          expect(recorded).not.toContain(fakeSecret)
        }
        const mainFiles = yield* worktreeEntries(sandbox.repo)
        expect(mainFiles).not.toContain("hello.txt")
        expect(yield* worktreeEntries(sandbox.worktrees)).toEqual([])
        expect(yield* codingBranches(sandbox.repo)).toHaveLength(1)
      }).pipe(Effect.provide(Services))
    }))
})
