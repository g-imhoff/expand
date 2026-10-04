import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer } from "effect"
import { AutomationClient } from "../automation/client"

const automationStub = Layer.succeed(AutomationClient, {
  createRoutine: () => Effect.succeed({ revision: 1 }),
  editRoutine: () => Effect.die("unused"),
  enableRoutine: () => Effect.die("unused"),
  pauseRoutine: () => Effect.die("unused"),
  deleteRoutine: () => Effect.die("unused"),
  getRoutine: () => Effect.die("unused"),
  listRoutines: () => Effect.succeed({ routines: [] }),
  putIntegration: () => Effect.die("unused"),
  getIntegration: () => Effect.die("unused"),
  integrationStatus: () => Effect.die("unused"),
  putCredential: () => Effect.succeed({ credentialId: "tok", version: 1, configured: true as const }),
  removeCredential: () => Effect.die("unused"),
  listCredentials: () => Effect.succeed({ credentials: [] }),
  previewClassification: () => Effect.die("unused"),
  listRuns: () => Effect.succeed({ runs: [], cursor: null }),
  getRun: () => Effect.die("unused"),
  runMetrics: () => Effect.succeed({ total: 0, queued: 0, running: 0, succeeded: 0, unresolved: 0, failed: 0, cancelled: 0 }),
  notificationList: () => Effect.die("unused"),
  notificationMarkRead: () => Effect.die("unused"),
  catalog: () => Effect.succeed({ schemaVersion: 1, kind: "catalog", definitions: [] })
})

describe("automation client", () => {
  it.effect("exposes routine create through AutomationClient", () =>
    Effect.flatMap(AutomationClient, (c) =>
      c.createRoutine({
        scope: { ownerId: "person", projectId: "project" },
        routineId: "triage",
        configuration: {},
        integrations: [],
        process: {
          schemaVersion: 1, kind: "process",
          trigger: { definition: { id: "github:issue-opened", version: 1 }, integration: { id: "github", definition: { id: "github:integration", version: 1 } }, configuration: {} },
          actions: {}
        }
      })
    ).pipe(
      Effect.provide(automationStub),
      Effect.tap((created) => Effect.sync(() => expect(created.revision).toBe(1)))
    ))

  it.effect("exposes credential put and catalog through AutomationClient", () =>
    Effect.gen(function*() {
      const client = yield* AutomationClient
      expect((yield* client.putCredential({ scope: { ownerId: "person", projectId: "project" }, credentialId: "tok", secret: "s" })).version).toBe(1)
      expect((yield* client.catalog()).definitions).toEqual([])
    }).pipe(Effect.provide(automationStub)))
})
