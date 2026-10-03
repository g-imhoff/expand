import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { HttpClient } from "effect/http"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { AutomationWorker, AutomationWorkerLayer, isRetryableActionError, isRetryableDecisionError, resolveOutcomeDescriptions, toActionFailure } from "../../automation/worker.js"
import { AutomationError } from "@expand/contracts/automation"
import { JevDecisionError } from "../../automation/jev-client.js"
import { makeSampleExtension, sampleAuthority, sampleConfiguration } from "../fixtures/automation-sample-extension.js"
import { configuration as decidedConfiguration, delivery as decidedDelivery, raw as decidedRaw, run as decidedRun } from "../fixtures/automation-persistence-fixture.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const withJev = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))

const layersFor = (registry: AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>, jev: { apiKey?: string; endpoint?: string }) => {
  const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
  const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
  const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
  const Routines = RoutineServiceLayer(registry).pipe(Layer.provide(Layer.mergeAll(Configs, Creds)))
  const Worker = AutomationWorkerLayer(registry, {
    maxAttempts: 3,
    baseBackoffMs: 1,
    attemptTimeoutMs: 5000,
    pollBatchSize: 20,
    concurrency: 4,
    pollIntervalMs: 10,
    jev: { ...(jev.apiKey === undefined ? {} : { apiKey: jev.apiKey }), ...(jev.endpoint === undefined ? {} : { endpoint: jev.endpoint }), timeoutMs: 5000, maxRetries: 0 }
  }).pipe(Layer.provide(Layer.mergeAll(Execs, Configs, Creds, Routines, NodeHttpClient.layerFetch)))
  return Layer.mergeAll(Ready, Configs, Creds, Execs, Routines, Worker, NodeHttpClient.layerFetch)
}

const sampleRevision = { ...sampleConfiguration, reference: { ...sampleConfiguration.reference, revision: 1 } }
const sampleAuthorityRevision = { ...sampleAuthority, configuration: sampleRevision.reference }

const seedSample = Effect.gen(function*() {
  const config = yield* ConfigurationRepository
  yield* config.putIntegration(sampleRevision.scope, sampleRevision.integrations[0]!, 0)
  yield* config.appendRoutineRevision(sampleRevision, 0, "enabled")
})

const seedDecided = Effect.gen(function*() {
  const config = yield* ConfigurationRepository
  yield* config.putIntegration(decidedConfiguration.scope, decidedConfiguration.integrations[0]!, 0)
  yield* config.appendRoutineRevision(decidedConfiguration, 0, "enabled")
})

const sampleDelivery = {
  schemaVersion: 1 as const,
  id: "sample-input",
  scope: sampleRevision.scope,
  integration: { id: "mail", definition: sampleRevision.integrations[0]!.definition },
  externalId: "sample-external",
  trigger: sampleRevision.process.trigger.definition,
  payload: { subject: "hello", count: "3" }
}

const sampleRun = {
  schemaVersion: 1 as const,
  kind: "run" as const,
  id: "sample-run",
  scope: sampleRevision.scope,
  configuration: sampleRevision.reference,
  input: { kind: "input-reference" as const, id: sampleDelivery.id },
  mode: "live" as const,
  authority: sampleAuthorityRevision,
  state: { kind: "queued" as const },
  actions: []
}

describe("worker outcome descriptions", () => {
  it.effect("prefers labels then descriptions then identity", () =>
    Effect.gen(function*() {
      expect(resolveOutcomeDescriptions({ labels: { a: "A", b: "B" } }, ["a", "b"])).toEqual({ a: "A", b: "B" })
      expect(resolveOutcomeDescriptions({ descriptions: { a: "Alpha" } }, ["a"])).toEqual({ a: "Alpha" })
      expect(resolveOutcomeDescriptions({ prefix: "hi" }, ["a", "b"])).toEqual({ a: "a", b: "b" })
      expect(resolveOutcomeDescriptions({ labels: { a: "A" } }, ["a", "b"])).toEqual({ a: "a", b: "b" })
    }))
})

describe("worker retry classification", () => {
  it.effect("retries rate limits and timeouts without retrying denials", () =>
    Effect.gen(function*() {
      expect(isRetryableDecisionError(new JevDecisionError({ code: "transient", message: "busy" }))).toBe(true)
      expect(isRetryableDecisionError(new JevDecisionError({ code: "timeout", message: "slow" }))).toBe(true)
      expect(isRetryableDecisionError(new JevDecisionError({ code: "auth", message: "bad" }))).toBe(false)
      expect(isRetryableActionError(new AutomationError({ code: "handler-failed", message: "busy", failure: { code: "rate-limited", message: "slow" } }))).toBe(true)
      expect(isRetryableActionError(new AutomationError({ code: "handler-failed", message: "gone", failure: { code: "not-found", message: "gone" } }))).toBe(false)
      expect(isRetryableActionError(new AutomationError({ code: "denied", message: "no" }))).toBe(false)
      expect(toActionFailure(new AutomationError({ code: "denied", message: "no" }), "send")).toEqual({ code: "denied", message: "Action send is outside the run grants" })
      expect(encode(toActionFailure(new AutomationError({ code: "denied", message: "no" }), "send"))).not.toContain("secret")
    }))
})

describe("worker state re-check", () => {
  it.live("skips paused routines as cancelled with a recorded skip", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension().extension)
      const Services = layersFor(registry, {})
      yield* Effect.gen(function*() {
        yield* seedSample
        const executions = yield* ExecutionRepository
        const routines = yield* RoutineService
        const worker = yield* AutomationWorker
        const calls: Array<unknown> = []
        void calls
        yield* executions.ingest({ delivery: sampleDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "sample-job", run: sampleRun }] })
        const head = yield* routines.get(sampleConfiguration.scope, sampleConfiguration.reference.routineId)
        yield* routines.pause(sampleConfiguration.scope, sampleConfiguration.reference.routineId, head!.head.version)
        yield* worker.processRun(sampleConfiguration.scope, sampleRun.id)
        const history = (yield* executions.history(sampleConfiguration.scope, sampleRun.id))!
        expect(history.run.value.state).toEqual({ kind: "cancelled", reason: "routine is not enabled for execution" })
        expect(history.attempts.some((attempt) => attempt.kind === "job" && attempt.status === "started")).toBe(true)
      }).pipe(Effect.provide(Services))
    }))
})

describe("worker grant enforcement", () => {
  it.live("rejects out-of-grant actions without invoking handlers", () =>
    Effect.gen(function*() {
      let handlerCalls = 0
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension(() => Effect.sync(() => {
        handlerCalls += 1
        return { summary: "called", total: 1 }
      })).extension)
      const Services = layersFor(registry, {})
      yield* Effect.gen(function*() {
        yield* seedSample
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        const denied = { ...sampleRun, id: "denied-run", authority: { ...sampleAuthorityRevision, actionGrants: [] } }
        yield* executions.ingest({ delivery: sampleDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "denied-job", run: denied }] })
        yield* worker.processRun(sampleConfiguration.scope, denied.id)
        const history = (yield* executions.history(sampleConfiguration.scope, denied.id))!
        expect(history.run.value.state.kind).toBe("failed")
        if (history.run.value.state.kind === "failed") expect(history.run.value.state.error.code).toBe("denied")
        expect(handlerCalls).toBe(0)
      }).pipe(Effect.provide(Services))
    }))
})

describe("worker retry budget", () => {
  it.live("respects the bounded retry budget per action", () =>
    Effect.gen(function*() {
      let attempts = 0
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension(() => {
        attempts += 1
        return attempts < 3
          ? Effect.fail({ code: "transient", message: "busy" })
          : Effect.succeed({ summary: "recovered", total: 1 })
      }).extension)
      const Services = layersFor(registry, {})
      yield* Effect.gen(function*() {
        yield* seedSample
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        yield* executions.ingest({ delivery: sampleDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "sample-job", run: sampleRun }] })
        yield* worker.processRun(sampleConfiguration.scope, sampleRun.id)
        const history = (yield* executions.history(sampleConfiguration.scope, sampleRun.id))!
        expect(history.run.value.state.kind).toBe("succeeded")
        expect(attempts).toBe(3)
        expect(history.attempts.filter((attempt) => attempt.kind === "action")).toHaveLength(3)
      }).pipe(Effect.provide(Services))
      let always = 0
      const failing = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* failing.register(makeSampleExtension(() => {
        always += 1
        return Effect.fail({ code: "transient", message: "busy" })
      }).extension)
      const FailingServices = layersFor(failing, {})
      yield* Effect.gen(function*() {
        yield* seedSample
        const executions = yield* ExecutionRepository
        const worker = yield* AutomationWorker
        yield* executions.ingest({ delivery: sampleDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "sample-job", run: sampleRun }] })
        yield* worker.processRun(sampleConfiguration.scope, sampleRun.id)
        const history = (yield* executions.history(sampleConfiguration.scope, sampleRun.id))!
        expect(history.run.value.state.kind).toBe("failed")
        expect(always).toBe(3)
      }).pipe(Effect.provide(FailingServices))
    }))
})

describe("worker outcome mapping", () => {
  it.live("maps completed failed cancelled and unresolved to distinct states", () =>
    Effect.gen(function*() {
      const stub = yield* withJev
      const registry = new AutomationRegistry<ConfigurationRepository | CredentialRepository | HttpClient.HttpClient>()
      yield* registry.register(makeSampleExtension().extension)
      const Services = layersFor(registry, { apiKey: "stub-zen-key-for-tests-only", endpoint: stub.url })
      yield* Effect.gen(function*() {
        yield* seedSample
        yield* seedDecided
        const executions = yield* ExecutionRepository
        const routines = yield* RoutineService
        const worker = yield* AutomationWorker
        yield* executions.ingest({ delivery: sampleDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "sample-job", run: sampleRun }] })
        yield* worker.processRun(sampleConfiguration.scope, sampleRun.id)
        expect((yield* executions.history(sampleConfiguration.scope, sampleRun.id))!.run.value.state.kind).toBe("succeeded")
        const deniedDelivery = { ...sampleDelivery, id: "denied-input", externalId: "denied-external" }
        const denied = { ...sampleRun, id: "denied-run", input: { kind: "input-reference" as const, id: deniedDelivery.id }, authority: { ...sampleAuthorityRevision, actionGrants: [] } }
        yield* executions.ingest({ delivery: deniedDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "denied-job", run: denied }] })
        yield* worker.processRun(sampleConfiguration.scope, denied.id)
        expect((yield* executions.history(sampleConfiguration.scope, denied.id))!.run.value.state.kind).toBe("failed")
        const pausedDelivery = { ...sampleDelivery, id: "paused-input", externalId: "paused-external" }
        const paused = { ...sampleRun, id: "paused-run", input: { kind: "input-reference" as const, id: pausedDelivery.id } }
        yield* executions.ingest({ delivery: pausedDelivery, raw: new Uint8Array([9]), targets: [{ jobId: "paused-job", run: paused }] })
        const head = yield* routines.get(sampleConfiguration.scope, sampleConfiguration.reference.routineId)
        yield* routines.pause(sampleConfiguration.scope, sampleConfiguration.reference.routineId, head!.head.version)
        yield* worker.processRun(sampleConfiguration.scope, paused.id)
        expect((yield* executions.history(sampleConfiguration.scope, paused.id))!.run.value.state.kind).toBe("cancelled")
        yield* routines.enable(sampleConfiguration.scope, sampleConfiguration.reference.routineId, head!.head.version + 1)
        stub.setReply(() => ({ status: 200, body: stubChoiceBody("no_match", { selected: 0.2, no_match: 0.8 }, 0.3) }))
        const unresolved = { ...decidedRun, id: "unresolved-run", input: { ...decidedRun.input, id: "unresolved-input" } }
        yield* executions.ingest({
          delivery: { ...decidedDelivery, id: "unresolved-input", externalId: "unresolved-external" },
          raw: decidedRaw,
          targets: [{ jobId: "unresolved-job", run: unresolved }]
        })
        yield* worker.processRun(decidedConfiguration.scope, unresolved.id)
        const stored = (yield* executions.history(decidedConfiguration.scope, unresolved.id))!
        expect(stored.run.value.state.kind).toBe("unresolved")
        expect(stored.run.value.decision?.kind).toBe("abstained")
      }).pipe(Effect.provide(Services))
    }))
})
