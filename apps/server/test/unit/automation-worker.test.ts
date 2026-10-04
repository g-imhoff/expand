import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepository, ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { ExecutionRepository, ExecutionRepositoryLayer } from "../../automation/execution-repository.js"
import { RoutineService, RoutineServiceLayer } from "../../automation/routine-service.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { DefaultAutomationWorkerOptions, processRun, startAutomationWorker } from "../../automation/worker.js"
import type { AutomationWorkerEnvironment } from "../../automation/worker.js"
import { makeSampleExtension } from "../fixtures/automation-sample-extension.js"

const scope = { ownerId: "worker-unit-owner", projectId: "worker-unit-project" }

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

const sampleProcess = {
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
        id: "send",
        action: { id: "sample:send" as const, version: 1 as const },
        integration: { id: "mail", definition: { id: "sample:mail" as const, version: 1 as const } },
        bindings: {
          message: { kind: "field" as const, source: "trigger" as const, path: ["subject"] },
          count: { kind: "field" as const, source: "trigger" as const, path: ["count"] }
        }
      }
    ]
  }
}

const unusedDecide: AutomationWorkerEnvironment["decide"] = () =>
  Effect.fail({ code: "unused", message: "unused" }) as never

describe("automation worker unit", () => {
  it.live("re-checks state and skips paused routines without executing", () =>
    Effect.gen(function*() {
      let calls = 0
      const registry = new AutomationRegistry()
      yield* registry.register(
        makeSampleExtension(() => Effect.sync(() => { calls += 1; return { summary: "hi", total: 1 } })).extension
      )
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        yield* routines.create(scope, {
          routineId: "mail",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration],
          process: sampleProcess
        })
        const head = (yield* routines.get(scope, "mail"))!.head
        yield* routines.pause(scope, "mail", head.version)
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-paused",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-paused",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-paused",
          scope,
          configuration: { routineId: "mail", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-paused" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "mail", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-paused", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, DefaultAutomationWorkerOptions, scope, "run-paused")
        expect(outcome).toBe("cancelled")
        expect(calls).toBe(0)
        expect((yield* executions.getRun(scope, "run-paused"))?.value.state.kind).toBe("cancelled")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("enforces authority grants with zero handler calls on deny", () =>
    Effect.gen(function*() {
      let calls = 0
      const registry = new AutomationRegistry()
      yield* registry.register(
        makeSampleExtension(() => Effect.sync(() => { calls += 1; return { summary: "hi", total: 1 } })).extension
      )
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        yield* routines.create(scope, {
          routineId: "mail",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration],
          process: sampleProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-denied",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-denied",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-denied",
          scope,
          configuration: { routineId: "mail", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-denied" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "mail", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: []
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-denied", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const outcome = yield* processRun(environment, DefaultAutomationWorkerOptions, scope, "run-denied")
        expect(outcome).toBe("failed")
        expect(calls).toBe(0)
        expect((yield* executions.getRun(scope, "run-denied"))?.value.state.kind).toBe("failed")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("respects the retry budget and records every attempt", () =>
    Effect.gen(function*() {
      let calls = 0
      let failuresLeft = 2
      const registry = new AutomationRegistry()
      yield* registry.register(
        makeSampleExtension(() =>
          Effect.gen(function*() {
            calls += 1
            if (failuresLeft > 0) {
              failuresLeft -= 1
              return yield* Effect.fail({ code: "handler-failed", message: "flaky" })
            }
            return { summary: "hi", total: 1 }
          })
        ).extension
      )
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        yield* routines.create(scope, {
          routineId: "mail",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration],
          process: sampleProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-retry",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-retry",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-retry",
          scope,
          configuration: { routineId: "mail", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-retry" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "mail", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-retry", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const options = { ...DefaultAutomationWorkerOptions, maxAttempts: 3, baseBackoffMs: 1, attemptTimeoutMs: 5000 }
        const outcome = yield* processRun(environment, options, scope, "run-retry")
        expect(outcome).toBe("completed")
        expect(calls).toBe(3)
        const history = (yield* executions.history(scope, "run-retry"))!
        expect(history.attempts.filter((entry) => entry.kind === "action").length).toBeGreaterThanOrEqual(3)
        expect(history.run.value.state.kind).toBe("succeeded")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("maps completed and cancelled outcomes distinctly", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        yield* routines.create(scope, {
          routineId: "mail",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration],
          process: sampleProcess
        })
        const ingest = (runId: string, jobId: string, deliveryId: string) =>
          Effect.gen(function*() {
            const delivery = {
              schemaVersion: 1 as const,
              id: deliveryId,
              scope,
              integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
              externalId: deliveryId,
              trigger: { id: "sample:received", version: 1 },
              payload: { subject: "hello", count: "2" }
            }
            const run = {
              schemaVersion: 1 as const,
              kind: "run" as const,
              id: runId,
              scope,
              configuration: { routineId: "mail", revision: 1 as const },
              input: { kind: "input-reference" as const, id: deliveryId },
              mode: "live" as const,
              authority: {
                schemaVersion: 1 as const,
                kind: "invocation-authority" as const,
                scope,
                configuration: { routineId: "mail", revision: 1 as const },
                integrationIds: ["mail"],
                actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
              },
              state: { kind: "queued" as const },
              actions: []
            }
            yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId, run }] })
          })
        yield* ingest("run-ok", "job-ok", "input-ok")
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const completed = yield* processRun(environment, DefaultAutomationWorkerOptions, scope, "run-ok")
        expect(completed).toBe("completed")
        expect((yield* executions.getRun(scope, "run-ok"))?.value.state.kind).toBe("succeeded")
        const head = (yield* routines.get(scope, "mail"))!.head
        yield* routines.pause(scope, "mail", head.version)
        yield* ingest("run-cancelled", "job-cancelled", "input-cancelled")
        const cancelled = yield* processRun(environment, DefaultAutomationWorkerOptions, scope, "run-cancelled")
        expect(cancelled).toBe("cancelled")
        expect((yield* executions.getRun(scope, "run-cancelled"))?.value.state.kind).toBe("cancelled")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("stops invoking after the retry budget is exhausted", () =>
    Effect.gen(function*() {
      let calls = 0
      const registry = new AutomationRegistry()
      yield* registry.register(
        makeSampleExtension(() =>
          Effect.gen(function*() {
            calls += 1
            return yield* Effect.fail({ code: "handler-failed", message: "always fails" })
          })
        ).extension
      )
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        yield* routines.create(scope, {
          routineId: "mail",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration],
          process: sampleProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-exhausted",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-exhausted",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-exhausted",
          scope,
          configuration: { routineId: "mail", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-exhausted" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "mail", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-exhausted", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const options = { ...DefaultAutomationWorkerOptions, maxAttempts: 3, baseBackoffMs: 1, attemptTimeoutMs: 5000 }
        const outcome = yield* processRun(environment, options, scope, "run-exhausted")
        expect(outcome).toBe("failed")
        expect(calls).toBe(3)
        expect((yield* executions.getRun(scope, "run-exhausted"))?.value.state.kind).toBe("failed")
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )

  it.live("starts with the backend loop and stops on interrupt", () =>
    Effect.gen(function*() {
      const registry = new AutomationRegistry()
      yield* registry.register(makeSampleExtension().extension)
      const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
      const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
      const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
      const Live = Layer.mergeAll(RoutineServiceLayer(registry), ExecutionRepositoryLayer, NodeHttpClient.layerFetch).pipe(
        Layer.provideMerge(Creds)
      )
      const program = Effect.gen(function*() {
        const routines = yield* RoutineService
        const executions = yield* ExecutionRepository
        const configurations = yield* ConfigurationRepository
        const credentials = yield* CredentialRepository
        const sql = yield* SqlClient
        const http = yield* HttpClient.HttpClient
        yield* credentials.putCredential(scope, "account-1", new TextEncoder().encode("secret"), 0)
        yield* routines.create(scope, {
          routineId: "mail",
          configuration: { prefix: "Hello" },
          integrations: [sampleIntegration],
          process: sampleProcess
        })
        const delivery = {
          schemaVersion: 1 as const,
          id: "input-lifecycle",
          scope,
          integration: { id: "mail", definition: { id: "sample:mail", version: 1 } },
          externalId: "input-lifecycle",
          trigger: { id: "sample:received", version: 1 },
          payload: { subject: "hello", count: "2" }
        }
        const run = {
          schemaVersion: 1 as const,
          kind: "run" as const,
          id: "run-lifecycle",
          scope,
          configuration: { routineId: "mail", revision: 1 as const },
          input: { kind: "input-reference" as const, id: "input-lifecycle" },
          mode: "live" as const,
          authority: {
            schemaVersion: 1 as const,
            kind: "invocation-authority" as const,
            scope,
            configuration: { routineId: "mail", revision: 1 as const },
            integrationIds: ["mail"],
            actionGrants: [{ action: { id: "sample:send", version: 1 }, integrationId: "mail", capabilities: ["send"] }]
          },
          state: { kind: "queued" as const },
          actions: []
        }
        yield* executions.ingest({ delivery, raw: new Uint8Array([1]), targets: [{ jobId: "job-lifecycle", run }] })
        const environment: AutomationWorkerEnvironment = {
          services: { configurations, credentials, executions, sql, http },
          registry,
          routines,
          decide: unusedDecide
        }
        const fiber = yield* Effect.forkChild(
          startAutomationWorker(environment, { ...DefaultAutomationWorkerOptions, pollIntervalMs: 10, baseBackoffMs: 1 })
        )
        let state = ""
        for (let i = 0; i < 100; i++) {
          state = (yield* executions.getRun(scope, "run-lifecycle"))?.value.state.kind ?? ""
          if (state === "succeeded") break
          yield* Effect.sleep("50 millis")
        }
        expect(state).toBe("succeeded")
        yield* Fiber.interrupt(fiber)
      })
      yield* program.pipe(Effect.provide(Live))
    }).pipe(Effect.scoped)
  )
})
