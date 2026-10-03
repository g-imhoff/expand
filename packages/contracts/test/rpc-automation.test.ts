import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { ExpandRpcs } from "@expand/contracts/rpc"
import {
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed
} from "@expand/contracts/rpc/automation-schemas"
import { DomainEventFromJson } from "@expand/contracts/events/domain"
import { AutomationRoutineChanged } from "@expand/contracts/events/automation"
import { Project } from "@expand/contracts/project"

const scope = { ownerId: "person", projectId: "project" }
const integration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "github-token" } }
}
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: false }
}

const payloadOf = (tag: string) => ExpandRpcs.requests.get(tag)!.payloadSchema
const successOf = (tag: string) => ExpandRpcs.requests.get(tag)!.successSchema

describe("contracts/rpc automation errors", () => {
  it("encodes tagged wire errors carrying code and message", () =>
    Effect.gen(function*() {
      for (const [schema, tag] of [
        [AutomationInvalid, "AutomationInvalid"],
        [AutomationConflict, "AutomationConflict"],
        [AutomationNotFound, "AutomationNotFound"],
        [AutomationStorageFailed, "AutomationStorageFailed"]
      ] as const) {
        const encoded = yield* Schema.encodeUnknownEffect(schema)(
          new schema({ code: "missing", message: "gone" })
        )
        expect(encoded).toMatchObject({ _tag: tag, code: "missing", message: "gone" })
      }
    }))

  it("exposes every automation procedure by tag", () => {
    const tags = [...ExpandRpcs.requests.keys()]
    for (const tag of [
      "AutomationRoutineCreate", "AutomationRoutineEdit", "AutomationRoutineEnable", "AutomationRoutinePause",
      "AutomationRoutineDelete", "AutomationRoutineGet", "AutomationRoutineList",
      "AutomationIntegrationPut", "AutomationIntegrationGet", "AutomationIntegrationStatus",
      "AutomationCredentialPut", "AutomationCredentialRemove", "AutomationCredentialList",
      "AutomationPreviewClassification",
      "AutomationRunList", "AutomationRunGet", "AutomationRunMetrics",
      "AutomationCatalog"
    ]) expect(tags).toContain(tag)
  })
})

describe("contracts/rpc automation payloads round-trip", () => {
  it.effect("routine create accepts a template or a custom definition", () =>
    Effect.gen(function*() {
      const schema = payloadOf("AutomationRoutineCreate")
      const templated = yield* Schema.decodeUnknownEffect(schema)({
        scope,
        routineId: "triage",
        template: { id: "github:issue-classification", version: 1 },
        configuration: classification,
        integrations: [integration],
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
      })
      expect(templated).toMatchObject({ routineId: "triage" })
      const custom = yield* Schema.decodeUnknownEffect(schema)({
        scope,
        routineId: "custom",
        configuration: classification,
        integrations: [integration],
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
      })
      expect(custom).toMatchObject({ routineId: "custom" })
      expect(yield* Schema.encodeUnknownEffect(schema)(templated)).toBeDefined()
    }))

  it.effect("credential writes accept a secret but responses never carry one", () =>
    Effect.gen(function*() {
      const toJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
      const put = yield* Schema.decodeUnknownEffect(payloadOf("AutomationCredentialPut"))({
        scope,
        credentialId: "github-token",
        secret: "super-secret-value"
      })
      expect(put).toMatchObject({ credentialId: "github-token" })
      const status = yield* Schema.decodeUnknownEffect(successOf("AutomationCredentialPut"))({
        credentialId: "github-token",
        version: 1,
        configured: true
      })
      const encoded = yield* Schema.encodeUnknownEffect(successOf("AutomationCredentialPut"))(status)
      expect(toJsonText(encoded)).not.toContain("super-secret-value")
      expect(encoded).not.toHaveProperty("secret")
      const listed = yield* Schema.decodeUnknownEffect(successOf("AutomationCredentialList"))({
        credentials: [{ credentialId: "github-token", version: 1, configured: true }]
      })
      expect(toJsonText(listed)).not.toContain("secret")
    }))

  it.effect("preview accepts an inline process with an explicit decision", () =>
    Effect.gen(function*() {
      const payload = yield* Schema.decodeUnknownEffect(payloadOf("AutomationPreviewClassification"))({
        scope,
        inline: {
          routineId: "draft",
          configuration: classification,
          integrations: [integration],
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
        },
        issue: { issueNumber: 7, title: "Boom" },
        decision: { schemaVersion: 1, kind: "abstained", reason: "no match" }
      })
      expect(payload).toMatchObject({ issue: { issueNumber: 7 } })
    }))

  it.effect("run list pages with cursor and outcome filters", () =>
    Effect.gen(function*() {
      const payload = yield* Schema.decodeUnknownEffect(payloadOf("AutomationRunList"))({
        scope,
        limit: 25,
        cursor: "opaque-cursor",
        routineId: "triage",
        mode: "live",
        state: "failed"
      })
      expect(payload).toMatchObject({ limit: 25, state: "failed" })
      const page = yield* Schema.decodeUnknownEffect(successOf("AutomationRunList"))({ runs: [], cursor: null })
      expect(page).toEqual({ runs: [], cursor: null })
    }))

  it.effect("metrics and catalog successes round-trip", () =>
    Effect.gen(function*() {
      expect(yield* Schema.decodeUnknownEffect(successOf("AutomationRunMetrics"))({
        total: 3,
        queued: 1,
        running: 1,
        succeeded: 0,
        unresolved: 0,
        failed: 1,
        cancelled: 0
      })).toMatchObject({ total: 3, failed: 1 })
      expect(yield* Schema.decodeUnknownEffect(successOf("AutomationCatalog"))({
        schemaVersion: 1,
        kind: "catalog",
        definitions: []
      })).toMatchObject({ kind: "catalog" })
    }))
})

describe("contracts/events automation", () => {
  it.effect("roundtrips an automation event through the domain envelope", () =>
    Effect.gen(function*() {
      const event = AutomationRoutineChanged.make({
        projectId: "project",
        ownerId: "person",
        routineId: "triage",
        revision: 2,
        status: "paused",
        occurredAt: "2026-10-03T00:00:00.000Z"
      })
      const json = yield* Schema.encodeEffect(DomainEventFromJson)(event)
      expect(yield* Schema.decodeUnknownEffect(DomainEventFromJson)(json)).toEqual(event)
    }))

  it("leaves the project fold unchanged", () => {
    const event = AutomationRoutineChanged.make({
      projectId: "project",
      ownerId: "person",
      routineId: "triage",
      revision: 2,
      status: "paused",
      occurredAt: "2026-10-03T00:00:00.000Z"
    })
    expect(Project.foldList([], event)).toEqual([])
  })
})
