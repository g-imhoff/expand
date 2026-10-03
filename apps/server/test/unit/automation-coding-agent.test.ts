import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Result } from "effect"
import { vi } from "vitest"
import {
  codingActionReference, codingIntegrationReference, codingTriggerReference, decodeJson,
  isPermittedCodingRepository, makeCodingExtension, resolveCodingAgent, resolveCodingDeadlineMs,
  CodingRepositoryConfiguration, CodingRunArguments
} from "@expand/contracts/automation"
import { AutomationRegistry } from "@expand/server/automation/registry"
import { makeCodingAdapter, negotiateCapabilities, nextCodingLifecycle, redactSecrets } from "@expand/server/automation/coding-agent"

const scope = { ownerId: "coding-owner", projectId: "coding-project" }
const codingConfiguration = {
  schemaVersion: 1 as const,
  kind: "routine-configuration" as const,
  reference: { routineId: "coding-routine", revision: 1 as const },
  scope,
  configuration: {},
  integrations: [{
    schemaVersion: 1 as const,
    kind: "integration-configuration" as const,
    id: "repo",
    definition: codingIntegrationReference,
    configuration: { allowedRepositories: ["/repo"] },
    credentials: {}
  }],
  process: {
    schemaVersion: 1 as const,
    kind: "process" as const,
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
          repository: { kind: "literal" as const, value: "/repo" },
          task: { kind: "field" as const, source: "trigger" as const, path: ["task"] },
          allowedActions: { kind: "literal" as const, value: ["read", "edit"] }
        }
      }]
    }
  }
}
const codingAuthority = {
  schemaVersion: 1 as const,
  kind: "invocation-authority" as const,
  scope,
  configuration: { routineId: "coding-routine", revision: 1 as const },
  integrationIds: ["repo"],
  actionGrants: [{ action: codingActionReference, integrationId: "repo", capabilities: ["code"] }]
}
const codingResult = {
  sessionId: "session-1",
  agent: "stub" as const,
  exitStatus: 0,
  durationMs: 12,
  transcript: ["opened"],
  diffSummary: "hello.txt | 1 +",
  filesChanged: ["hello.txt"]
}
const codingInvocation = {
  configuration: codingConfiguration,
  stepId: "code",
  triggerPayload: { task: "add hello" },
  mode: "live" as const
}

describe("coding session lifecycle", () => {
  it.effect("advances through start, succeed, fail, cancel and timeout", () =>
    Effect.gen(function*() {
      expect(nextCodingLifecycle("created", "start")).toBe("running")
      expect(nextCodingLifecycle("created", "cancel")).toBe("cancelled")
      expect(nextCodingLifecycle("running", "succeed")).toBe("succeeded")
      expect(nextCodingLifecycle("running", "fail")).toBe("failed")
      expect(nextCodingLifecycle("running", "cancel")).toBe("cancelled")
      expect(nextCodingLifecycle("running", "timeout")).toBe("timed-out")
      expect(nextCodingLifecycle("created", "succeed")).toBeNull()
      expect(nextCodingLifecycle("running", "start")).toBeNull()
      expect(nextCodingLifecycle("succeeded", "fail")).toBeNull()
      expect(nextCodingLifecycle("failed", "cancel")).toBeNull()
      expect(nextCodingLifecycle("cancelled", "timeout")).toBeNull()
      expect(nextCodingLifecycle("timed-out", "succeed")).toBeNull()
    }))
})

describe("coding agent negotiation", () => {
  it.effect("accepts a versioned hello and rejects anything else", () =>
    Effect.gen(function*() {
      const adapter = makeCodingAdapter("stub", ["stub"])
      const hello = {
        protocolVersion: 1,
        agentCapabilities: { session: true },
        agentInfo: { name: "StubCodingAgent" }
      }
      expect(yield* negotiateCapabilities(adapter, hello)).toEqual({ session: true, prompt: true, cancel: true })
      for (const broken of [
        { protocolVersion: 2, agentCapabilities: {} },
        { protocolVersion: 1 },
        {},
        "hello",
        null
      ]) {
        const settled = yield* Effect.result(negotiateCapabilities(adapter, broken))
        expect(Result.isFailure(settled)).toBe(true)
        if (Result.isFailure(settled)) expect(settled.failure.code).toBe("negotiation")
      }
    }))
  it.effect("resolves agent kinds without changing the engine", () =>
    Effect.gen(function*() {
      expect(makeCodingAdapter("opencode", ["opencode", "acp"]).kind).toBe("opencode")
      expect(makeCodingAdapter("stub", ["stub"]).kind).toBe("stub")
      expect(makeCodingAdapter("stub", ["stub"]).requiredCapabilities).toEqual(["session", "prompt"])
    }))
  it.effect("extracts transcript progress only from session updates", () =>
    Effect.gen(function*() {
      const adapter = makeCodingAdapter("stub", ["stub"])
      const update = adapter.progressFromNotification("session/update", {
        sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: "working" }
      })
      expect(update).toMatchObject({ kind: "transcript", text: expect.stringContaining("working") })
      expect(adapter.progressFromNotification("session/other", {})).toBeNull()
      expect(adapter.progressFromNotification("session/update", { sessionId: "s", update: {} })).toBeNull()
    }))
})

describe("coding secrets", () => {
  it.effect("redacts every secret value from recorded text", () =>
    Effect.gen(function*() {
      expect(redactSecrets("token s3cr3t here s3cr3t", ["s3cr3t", ""])).toBe("token [redacted] here [redacted]")
      expect(redactSecrets("nothing to hide", ["s3cr3t"])).toBe("nothing to hide")
    }))
})

describe("coding routine configuration", () => {
  it.effect("binds repository, actions and deadlines to the routine", () =>
    Effect.gen(function*() {
      const configuration = yield* decodeJson(CodingRepositoryConfiguration, { allowedRepositories: ["/repo"], agent: "stub" })
      expect(resolveCodingAgent(configuration)).toBe("stub")
      expect(isPermittedCodingRepository(configuration, "/repo")).toBe(true)
      expect(isPermittedCodingRepository(configuration, "/elsewhere")).toBe(false)
      const args = yield* decodeJson(CodingRunArguments, { repository: "/repo", task: "add hello", allowedActions: ["read"] })
      expect(resolveCodingDeadlineMs(args, configuration)).toBe(300000)
      expect(resolveCodingDeadlineMs({ ...args, deadlineMs: 5000 }, configuration)).toBe(5000)
      const rejected = yield* Effect.result(decodeJson(CodingRunArguments, { repository: "/repo", task: "", allowedActions: ["read"] }))
      expect(Result.isFailure(rejected)).toBe(true)
      const unknown = yield* Effect.result(decodeJson(CodingRunArguments, { repository: "/repo", task: "x", allowedActions: ["fly"] }))
      expect(Result.isFailure(unknown)).toBe(true)
    }))
})

describe("coding action grants", () => {
  it.effect("invokes the handler only for an exactly granted action", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed(codingResult))
      const registry = new AutomationRegistry()
      yield* registry.register(makeCodingExtension(handler).extension)
      expect(yield* registry.invokeAction(codingInvocation, codingAuthority)).toEqual(codingResult)
      expect(handler).toHaveBeenCalledTimes(1)
    }))
  it.effect("denies every ungranted invocation before the handler launches", () =>
    Effect.gen(function*() {
      const handler = vi.fn(() => Effect.succeed(codingResult))
      const registry = new AutomationRegistry()
      yield* registry.register(makeCodingExtension(handler).extension)
      for (const authority of [
        { ...codingAuthority, integrationIds: [] },
        { ...codingAuthority, actionGrants: [] },
        { ...codingAuthority, actionGrants: [{ action: codingActionReference, integrationId: "repo", capabilities: [] }] },
        { ...codingAuthority, actionGrants: [{ action: codingActionReference, integrationId: "other", capabilities: ["code"] }] }
      ]) {
        const settled = yield* Effect.result(registry.invokeAction(codingInvocation, authority))
        expect(Result.isFailure(settled)).toBe(true)
        if (Result.isFailure(settled)) expect(settled.failure.code).toBe("denied")
      }
      expect(handler).not.toHaveBeenCalled()
    }))
})
