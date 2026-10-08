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
import { allowedPathsCheck, decodeSkillInputs, evaluateCompletionChecks, resolveSkill } from "../../automation/skill-registry.js"
import { sampleWriteFileSkill, sampleSkills } from "../../automation/sample-skills.js"
import type { SkillDefinition } from "../../automation/skill-registry.js"
import { DefaultAutomationWorkerOptions, processRun } from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"
import { SampleWriteFileInput } from "@expand/contracts/automation/skills"

const scope = { ownerId: "skill-owner", projectId: "skill-project" }
const stubPath = fileURLToPath(new URL("../fixtures/automation-acp-stub.mjs", import.meta.url))

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

const skillProcess = {
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
        id: "skill",
        action: { id: "coding-skill:execute" as const, version: 1 as const },
        integration: { id: "coding", definition: { id: "coding-agent:integration" as const, version: 1 as const } },
        bindings: {
          skillId: { kind: "literal" as const, value: "sample-write-file" },
          inputs: { kind: "literal" as const, value: { content: "hello-from-skill" } },
          agentKind: { kind: "literal" as const, value: "opencode" },
          timeoutMs: { kind: "literal" as const, value: 8000 }
        }
      }
    ]
  }
}

const rogueSkill: SkillDefinition = {
  id: "rogue-write",
  version: 1,
  title: "Rogue write",
  description: "Writes outside its allowed paths",
  inputSchema: SampleWriteFileInput,
  requiredCapabilities: ["execute"],
  allowedPaths: ["OUTPUT.md"],
  buildPrompt: (inputs) => {
    const record = inputs as { readonly content?: unknown }
    const raw = typeof record.content === "string" ? record.content : ""
    return ["write:UNRELATED.md:" + raw.split("\n")[0], "Report wrote UNRELATED.md."].join("\n")
  }
}

const rogueProcess = {
  ...skillProcess,
  actions: {
    triggered: [
      {
        id: "skill",
        action: { id: "coding-skill:execute" as const, version: 1 as const },
        integration: { id: "coding", definition: { id: "coding-agent:integration" as const, version: 1 as const } },
        bindings: {
          skillId: { kind: "literal" as const, value: "rogue-write" },
          inputs: { kind: "literal" as const, value: { content: "rogue-content" } },
          agentKind: { kind: "literal" as const, value: "opencode" },
          timeoutMs: { kind: "literal" as const, value: 8000 }
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

const skillAuthority = {
  schemaVersion: 1 as const,
  kind: "invocation-authority" as const,
  scope,
  configuration: { routineId: "skill", revision: 1 as const },
  integrationIds: ["mail", "coding"],
  actionGrants: [{ action: { id: "coding-skill:execute", version: 1 }, integrationId: "coding", capabilities: ["execute"] }]
}

describe("automation skills", () => {
  it.effect("validates skill inputs, unknown skills, and allowed-path checks", () =>
    Effect.gen(function*() {
      const missing = yield* Effect.exit(resolveSkill(sampleSkills, "missing-skill"))
      expect(missing._tag).toBe("Failure")
      const known = yield* resolveSkill(sampleSkills, "sample-write-file")
      expect(known.id).toBe("sample-write-file")
      expect(known.requiredCapabilities).toEqual(["execute"])
      const bad = yield* Effect.exit(decodeSkillInputs(sampleWriteFileSkill, { content: "" }))
      expect(bad._tag).toBe("Failure")
      const good = yield* decodeSkillInputs(sampleWriteFileSkill, { content: "ok" })
      expect((good as { content: string }).content).toBe("ok")
      const prompt = sampleWriteFileSkill.buildPrompt({ content: "hello" })
      expect(prompt).toContain("write:OUTPUT.md:hello")
      expect(prompt).not.toContain("super-secret")
      const passing = evaluateCompletionChecks(sampleWriteFileSkill, {
        transcript: ["stub working", "wrote OUTPUT.md"],
        diffSummary: "?? OUTPUT.md\n OUTPUT.md | 1 +",
        exitStatus: 0
      })
      expect(passing.every((check) => check.passed)).toBe(true)
      const unrelated = allowedPathsCheck(["OUTPUT.md"], "?? UNRELATED.md\n UNRELATED.md | 1 +")
      expect(unrelated.passed).toBe(false)
      const subdir = allowedPathsCheck(["OUTPUT.md"], "?? sub/OUTPUT.md\n sub/OUTPUT.md | 1 +")
      expect(subdir.passed).toBe(false)
      const extensionless = allowedPathsCheck(["OUTPUT.md"], "?? Makefile\n Makefile | 1 +")
      expect(extensionless.passed).toBe(false)
      const empty = allowedPathsCheck(["OUTPUT.md"], "")
      expect(empty.passed).toBe(false)
    }))

  it.live("executes the sample skill through ACP and keeps runs inspectable without leaking the credential", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const secret = "super-secret-skill-xyz"
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "skill-worktrees-success-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: SkillConnectorServices = { configurations, credentials }
        yield* registry.register(makeSampleExtension().extension)
        yield* registry.register(
          makeSkillConnectorExtension(
            { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, skills: sampleSkills },
            services
          ).extension
        )
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret-1"), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode(secret), 0)
        yield* routines.create(scope, {
          routineId: "skill",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration, codingIntegration],
          process: skillProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-skill-1",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 } },
          externalId: "input-skill-1",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "skill-run", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-skill-1",
          scope,
          configuration: { routineId: "skill", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-skill-1" },
          mode: "live" as const,
          authority: skillAuthority,
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-skill-1", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1 }, scope, "run-skill-1")
        expect(outcome).toBe("completed")
        const stored = (yield* executions.getRun(scope, "run-skill-1"))!
        expect(stored.value.state.kind).toBe("succeeded")
        const history = (yield* executions.history(scope, "run-skill-1"))!
        const completed = history.attempts.filter((entry) => entry.kind === "action" && entry.status === "completed")
        expect(completed.length).toBeGreaterThanOrEqual(1)
        const outcomeValue = (completed[0] as { outcome: { kind: string; result: unknown } }).outcome
        expect(outcomeValue.kind).toBe("succeeded")
        const result = outcomeValue.result as { skillId: string; transcript: Array<string>; diffSummary: string; exitStatus: number; checks: Array<{ check: string; passed: boolean }> }
        expect(result.skillId).toBe("sample-write-file")
        expect(result.exitStatus).toBe(0)
        expect(result.checks.length).toBe(4)
        expect(result.checks.every((check) => check.passed)).toBe(true)
        expect(result.transcript.join("\n")).toContain("wrote OUTPUT.md")
        expect(result.diffSummary).toContain("OUTPUT.md")
        const encoded = yield* Schema.encodeUnknownEffect(Schema.Json)(result as unknown as Schema.Json)
        const flat = [...result.transcript, result.diffSummary].join("\n")
        expect(flat).not.toContain(secret)
        expect(encoded).not.toContain(secret)
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("rejects ungranted skill capabilities before configuration lookup", () =>
    Effect.gen(function*() {
      clearCodingAdapters()
      const escalatedSkill: SkillDefinition = {
        id: "escalated-admin",
        version: 1,
        title: "Escalated",
        description: "Requests admin",
        inputSchema: SampleWriteFileInput,
        requiredCapabilities: ["admin"],
        allowedPaths: ["OUTPUT.md"],
        buildPrompt: () => "write:OUTPUT.md:ok"
      }
      let configCalls = 0
      let credentialCalls = 0
      const configurations = {
        getIntegration: () =>
          Effect.sync(() => {
            configCalls += 1
          }).pipe(Effect.flatMap(() => Effect.die("configuration lookup must not precede grant check")))
      } as unknown as SkillConnectorServices["configurations"]
      const credentials = {
        resolveSecret: () =>
          Effect.sync(() => {
            credentialCalls += 1
          }).pipe(Effect.flatMap(() => Effect.die("credential lookup must not precede grant check")))
      } as unknown as SkillConnectorServices["credentials"]
      const connector = makeSkillConnectorExtension(
        { worktreeRoot: "/tmp/skill-grant-check", agentCommand: "node", agentArgs: [], defaultTimeoutMs: 8000, skills: [escalatedSkill] },
        { configurations, credentials }
      )
      const installed = connector.extension.actions[0] as (typeof connector.extension.actions)[number]
      const error = yield* installed.invoke(
        { skillId: "escalated-admin", inputs: { content: "ok" } },
        { repository: "octo/hello" },
        { scope, routineId: "skill", configurationRevision: 1, integrationId: "coding", mode: "preview" }
      ).pipe(Effect.flip)
      expect(error.code).toBe("handler-failed")
      expect(error.failure?.code).toBe("invalid-contract")
      expect(error.failure?.message ?? error.message).toContain("admin")
      expect(configCalls).toBe(0)
      expect(credentialCalls).toBe(0)
      clearCodingAdapters()
    }))

  it.live("fails completion checks when the agent edits outside the allowed paths", () =>
    Effect.gen(function*() {
      resetCodingAdaptersForTests()
      clearCodingAdapters()
      const fs = yield* FileSystem.FileSystem
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "skill-worktrees-rogue-" })
      const { registry, Live } = setupLayers()
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        const services: SkillConnectorServices = { configurations, credentials }
        yield* registry.register(makeSampleExtension().extension)
        yield* registry.register(
          makeSkillConnectorExtension(
            { worktreeRoot, agentCommand: "node", agentArgs: [stubPath], defaultTimeoutMs: 8000, skills: [sampleWriteFileSkill, rogueSkill] },
            services
          ).extension
        )
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret-1"), 0)
        yield* credentials.putCredential(scope, "coding-token", new TextEncoder().encode("stub-token"), 0)
        yield* routines.create(scope, {
          routineId: "skill",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration, codingIntegration],
          process: rogueProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-rogue-1",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 } },
          externalId: "input-rogue-1",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "rogue-run", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-rogue-1",
          scope,
          configuration: { routineId: "skill", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-rogue-1" },
          mode: "live" as const,
          authority: skillAuthority,
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-rogue-1", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, { ...DefaultAutomationWorkerOptions, attemptTimeoutMs: 15000, baseBackoffMs: 1, maxAttempts: 1 }, scope, "run-rogue-1")
        expect(outcome).toBe("failed")
        const history = (yield* executions.history(scope, "run-rogue-1"))!
        const failed = history.attempts.filter((entry) => entry.kind === "action" && entry.status === "completed" && entry.outcome.kind === "failed")
        expect(failed.length).toBeGreaterThanOrEqual(1)
        const error = (failed[0] as unknown as { outcome: { kind: string; error: { code: string; message: string } } }).outcome.error
        expect(error.code).toBe("handler-failed")
        expect(error.message).toContain("rogue-write")
        expect(error.message).toContain("diff-only-allowed-paths")
        expect(yield* readRoot(fs, worktreeRoot)).toEqual([])
      })
      const Full = Layer.mergeAll(Live, NodeServices.layer)
      yield* program.pipe(Effect.provide(Full))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
