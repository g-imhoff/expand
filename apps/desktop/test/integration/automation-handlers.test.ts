import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import {
  ClientSession,
  type ClientSessionApi,
  type ConnectionStatus
} from "@expand/client-ts"
import {
  AutomationClient,
  type AutomationClientApi
} from "@expand/client-ts/automation"
import { ServerClient } from "@expand/client-ts/server"
import { automationHandlers } from "@expand/desktop/main/rpc/automation-handlers"
import { AutomationRpc, AutomationRpcLayer } from "@expand/desktop/renderer/rpc/automation-rpc"
import { RendererRpcClient } from "@expand/desktop/renderer/rpc/transport"

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

const recorded: Array<{ readonly method: string; readonly payload: unknown }> = []

const client = {
  routineCreate: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routineCreate", payload })
    return { revision: 1 }
  }),
  routineEdit: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routineEdit", payload })
    return { revision: 2 }
  }),
  routineEnable: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routineEnable", payload })
    return { revision: 2, version: 3, status: "enabled" }
  }),
  routinePause: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routinePause", payload })
    return { revision: 2, version: 3, status: "paused" }
  }),
  routineDelete: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routineDelete", payload })
    return { revision: 2, version: 4, status: "deleted" }
  }),
  routineGet: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routineGet", payload })
    return { routineId: "triage" }
  }),
  routineList: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "routineList", payload })
    return { routines: [] }
  }),
  integrationPut: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "integrationPut", payload })
    return { version: 1 }
  }),
  integrationGet: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "integrationGet", payload })
    return { version: 1 }
  }),
  integrationStatus: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "integrationStatus", payload })
    return { ok: true, blocked: false }
  }),
  credentialPut: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "credentialPut", payload })
    return { credentialId: "token", version: 1, configured: true }
  }),
  credentialRemove: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "credentialRemove", payload })
    return { removed: true }
  }),
  credentialList: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "credentialList", payload })
    return { credentials: [] }
  }),
  previewClassification: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "previewClassification", payload })
    return { kind: "failed" }
  }),
  runList: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "runList", payload })
    return { runs: [], cursor: null }
  }),
  runGet: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "runGet", payload })
    return { runId: "run-1" }
  }),
  runMetrics: (payload: unknown) => Effect.sync(() => {
    recorded.push({ method: "runMetrics", payload })
    return { total: 0 }
  }),
  catalog: () => Effect.sync(() => {
    recorded.push({ method: "catalog", payload: {} })
    return { kind: "catalog" }
  })
}

const automationClient = client as unknown as AutomationClientApi

const makeClientLayer = (
  status: SubscriptionRef.SubscriptionRef<ConnectionStatus>
) => {
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(AutomationClient, automationClient),
    Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
  )
}

const handlers = automationHandlers as unknown as {
  readonly AutomationRoutineCreate: (payload: Parameters<AutomationClientApi["routineCreate"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRoutineEdit: (payload: Parameters<AutomationClientApi["routineEdit"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRoutineEnable: (payload: Parameters<AutomationClientApi["routineEnable"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRoutinePause: (payload: Parameters<AutomationClientApi["routinePause"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRoutineDelete: (payload: Parameters<AutomationClientApi["routineDelete"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRoutineGet: (payload: Parameters<AutomationClientApi["routineGet"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRoutineList: (payload: Parameters<AutomationClientApi["routineList"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationIntegrationPut: (payload: Parameters<AutomationClientApi["integrationPut"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationIntegrationGet: (payload: Parameters<AutomationClientApi["integrationGet"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationIntegrationStatus: (payload: Parameters<AutomationClientApi["integrationStatus"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationCredentialPut: (payload: Parameters<AutomationClientApi["credentialPut"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationCredentialRemove: (payload: Parameters<AutomationClientApi["credentialRemove"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationCredentialList: (payload: Parameters<AutomationClientApi["credentialList"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationPreviewClassification: (payload: Parameters<AutomationClientApi["previewClassification"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRunList: (payload: Parameters<AutomationClientApi["runList"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRunGet: (payload: Parameters<AutomationClientApi["runGet"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationRunMetrics: (payload: Parameters<AutomationClientApi["runMetrics"]>[0]) => Effect.Effect<unknown, unknown, AutomationClient>
  readonly AutomationCatalog: () => Effect.Effect<unknown, unknown, AutomationClient>
}

const runAutomationHandlers = () =>
  Effect.gen(function* () {
    recorded.length = 0
    const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
    const layer = makeClientLayer(status)
    yield* handlers.AutomationRoutineCreate({ scope, routineId: "triage", ...write }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRoutineEdit({ scope, routineId: "triage", ...write }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRoutineEnable({ scope, routineId: "triage", expectedVersion: 2 }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRoutinePause({ scope, routineId: "triage", expectedVersion: 3 }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRoutineDelete({ scope, routineId: "triage", expectedVersion: 4 }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRoutineGet({ scope, routineId: "triage" }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRoutineList({ scope }).pipe(Effect.provide(layer))
    yield* handlers.AutomationIntegrationPut({ scope, integration: write as never }).pipe(Effect.provide(layer))
    yield* handlers.AutomationIntegrationGet({ scope, integrationId: "github" }).pipe(Effect.provide(layer))
    yield* handlers.AutomationIntegrationStatus({ scope, integrationId: "github" }).pipe(Effect.provide(layer))
    yield* handlers.AutomationCredentialPut({ scope, credentialId: "token", secret: "s3cr3t" }).pipe(Effect.provide(layer))
    yield* handlers.AutomationCredentialRemove({ scope, credentialId: "token", expectedVersion: 1 }).pipe(Effect.provide(layer))
    yield* handlers.AutomationCredentialList({ scope }).pipe(Effect.provide(layer))
    yield* handlers.AutomationPreviewClassification({
      scope,
      routineId: "triage",
      issue: { issueNumber: 1, title: "Hi" },
      decision: { schemaVersion: 1, kind: "abstained", reason: "none" }
    }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRunList({ scope, limit: 10 }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRunGet({ scope, runId: "run-1" }).pipe(Effect.provide(layer))
    yield* handlers.AutomationRunMetrics({ scope }).pipe(Effect.provide(layer))
    yield* handlers.AutomationCatalog().pipe(Effect.provide(layer))
    return [...recorded]
  })

describe("DesktopAutomationHandlers", () => {
  it.effect("forwards every automation call to AutomationClient with its payload", () =>
    Effect.flatMap(runAutomationHandlers(), (entries) =>
      Effect.sync(() => {
        expect(entries.map((entry) => entry.method)).toEqual([
          "routineCreate", "routineEdit", "routineEnable", "routinePause", "routineDelete",
          "routineGet", "routineList",
          "integrationPut", "integrationGet", "integrationStatus",
          "credentialPut", "credentialRemove", "credentialList",
          "previewClassification",
          "runList", "runGet", "runMetrics",
          "catalog"
        ])
        expect(entries[0]?.payload).toMatchObject({ routineId: "triage" })
        expect(entries[10]?.payload).toMatchObject({ credentialId: "token", secret: "s3cr3t" })
        expect(entries[14]?.payload).toMatchObject({ limit: 10 })
      })))
})

describe("RendererAutomationRpc", () => {
  it.effect("delegates to the shared RPC channel over the existing port", () =>
    Effect.gen(function*() {
      const seen: Array<{ readonly method: string; readonly payload: unknown }> = []
      const port = {
        AutomationRoutineCreate: (payload: unknown) => Effect.sync(() => {
          seen.push({ method: "AutomationRoutineCreate", payload })
          return { revision: 1 }
        }),
        AutomationRoutineList: (payload: unknown) => Effect.sync(() => {
          seen.push({ method: "AutomationRoutineList", payload })
          return { routines: [] }
        }),
        AutomationCatalog: (payload: unknown) => Effect.sync(() => {
          seen.push({ method: "AutomationCatalog", payload })
          return { schemaVersion: 1, kind: "catalog", definitions: [] }
        }),
        Events: (payload: unknown) => {
          seen.push({ method: "Events", payload })
          return Stream.empty
        }
      }
      const rpc = yield* AutomationRpc.pipe(
        Effect.provide(AutomationRpcLayer),
        Effect.provideService(RendererRpcClient, port as never)
      )
      expect(yield* rpc.routineCreate({ scope, routineId: "triage", ...write })).toEqual({ revision: 1 })
      expect(yield* rpc.routineList({ scope })).toEqual({ routines: [] })
      expect(yield* rpc.catalog()).toMatchObject({ kind: "catalog" })
      const events = rpc.events({ fromSeq: 42 })
      expect(Stream.isStream(events)).toBe(true)
      expect(seen.map((entry) => entry.method)).toEqual([
        "AutomationRoutineCreate",
        "AutomationRoutineList",
        "AutomationCatalog",
        "Events"
      ])
      expect(seen[3]?.payload).toEqual({ fromSeq: 42 })
    }))
})
