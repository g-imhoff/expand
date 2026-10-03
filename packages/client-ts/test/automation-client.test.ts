import { it } from "@effect/vitest"
import { beforeEach, describe, expect } from "vitest"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { AutomationClient, AutomationClientLive } from "../automation/client"
import { ClientSession, type ClientSessionApi, type ConnectionStatus } from "../client-session"
import type { ExpandRpcClientApi } from "../rpc-client"

const scope = { ownerId: "person", projectId: "project" }
const write = {
  configuration: { categories: ["bug"] },
  integrations: [],
  process: {
    schemaVersion: 1,
    kind: "process",
    trigger: {
      definition: { id: "github:issue-opened", version: 1 },
      integration: { id: "github", definition: { id: "github:integration", version: 1 } },
      configuration: {}
    },
    actions: {}
  }
} as const

const calls: Array<{ readonly method: string; readonly payload: unknown }> = []
const rpc = {
  AutomationRoutineCreate: (payload: unknown) => Effect.tap(Effect.succeed({ revision: 1 }), () => Effect.sync(() => { calls.push({ method: "create", payload }) })),
  AutomationRoutineList: (payload: unknown) => Effect.tap(Effect.succeed({ routines: [] }), () => Effect.sync(() => { calls.push({ method: "list", payload }) })),
  AutomationPreviewClassification: (payload: unknown) => Effect.tap(
    Effect.succeed({ kind: "failed", request: {}, error: { code: "x", message: "y" }, latencyMs: 0, executed: false }),
    () => Effect.sync(() => { calls.push({ method: "preview", payload }) })
  ),
  AutomationRunList: (payload: unknown) => Effect.tap(Effect.succeed({ runs: [], cursor: null }), () => Effect.sync(() => { calls.push({ method: "runs", payload }) })),
  AutomationCatalog: (payload: unknown) => Effect.tap(
    Effect.succeed({ schemaVersion: 1, kind: "catalog", definitions: [] }),
    () => Effect.sync(() => { calls.push({ method: "catalog", payload }) })
  )
} as unknown as ExpandRpcClientApi

const layerFor = (status: SubscriptionRef.SubscriptionRef<ConnectionStatus>) => {
  const session: ClientSessionApi = {
    status,
    current: Effect.succeed(rpc),
    epochs: Stream.empty
  }
  return AutomationClientLive.pipe(Layer.provideMerge(Layer.succeed(ClientSession, session)))
}

const runWith = <A>(effect: Effect.Effect<A, unknown, AutomationClient>) =>
  Effect.gen(function*() {
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
    return yield* effect.pipe(Effect.provide(layerFor(status)))
  })

describe("AutomationClient", () => {
  beforeEach(() => {
    calls.length = 0
  })
  it.effect("delegates routine calls with the caller's payload", () =>
    runWith(Effect.flatMap(AutomationClient, (client) =>
      client.routineCreate({ scope, routineId: "triage", ...write })
    )).pipe(
      Effect.tap((result) => Effect.sync(() => {
        expect(result).toEqual({ revision: 1 })
        expect(calls.at(-1)).toMatchObject({ method: "create", payload: { routineId: "triage" } })
      }))
    ))

  it.effect("delegates list preview runs and catalog calls", () =>
    runWith(Effect.flatMap(AutomationClient, (client) => Effect.gen(function*() {
      expect(yield* client.routineList({ scope })).toEqual({ routines: [] })
      expect((yield* client.runList({ scope, limit: 10 })).cursor).toBeNull()
      expect(yield* client.catalog()).toMatchObject({ kind: "catalog" })
      const outcome = yield* client.previewClassification({
        scope,
        routineId: "triage",
        issue: { issueNumber: 1, title: "Hi" },
        decision: { schemaVersion: 1, kind: "abstained", reason: "none" }
      })
      expect(outcome).toMatchObject({ kind: "failed" })
      expect(calls.map((call) => call.method)).toEqual(["list", "runs", "catalog", "preview"])
    })))
  )

  it.effect("exposes the full automation surface", () =>
    runWith(Effect.flatMap(AutomationClient, (client) => Effect.sync(() => {
      const api = client as unknown as Record<string, unknown>
      for (const method of [
        "routineCreate", "routineEdit", "routineEnable", "routinePause", "routineDelete",
        "routineGet", "routineList",
        "integrationPut", "integrationGet", "integrationStatus",
        "credentialPut", "credentialRemove", "credentialList",
        "previewClassification",
        "runList", "runGet", "runMetrics",
        "catalog"
      ]) expect(api[method], method).toBeTypeOf("function")
    })))
  )
})
