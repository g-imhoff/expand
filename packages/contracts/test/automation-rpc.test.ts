import { it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import { ExpandRpcs } from "@expand/contracts/rpc"
import {
  AutomationConflict,
  AutomationInvalid,
  AutomationNotFound,
  AutomationStorageFailed
} from "@expand/contracts/rpc/automation-schemas"

const tags = [
  "AutomationRoutineCreate",
  "AutomationRoutineEdit",
  "AutomationRoutineEnable",
  "AutomationRoutinePause",
  "AutomationRoutineDelete",
  "AutomationRoutineGet",
  "AutomationRoutineList",
  "AutomationIntegrationPut",
  "AutomationIntegrationGet",
  "AutomationIntegrationStatus",
  "AutomationCredentialPut",
  "AutomationCredentialRemove",
  "AutomationCredentialList",
  "AutomationPreviewClassification",
  "AutomationRunList",
  "AutomationRunGet",
  "AutomationRunMetrics",
  "AutomationCatalog"
]

describe("contracts/rpc automation tags", () => {
  it("exposes every automation procedure", () => {
    const names = [...ExpandRpcs.requests.keys()]
    for (const tag of tags) expect(names).toContain(tag)
  })

  it("encodes automation errors as tagged wire objects", () => {
    expect(new AutomationNotFound({ code: "missing", message: "nope" })._tag).toBe("AutomationNotFound")
    expect(new AutomationConflict({ code: "conflict", message: "dup" }).code).toBe("conflict")
    expect(new AutomationInvalid({ code: "invalid-reference", message: "bad" }).message).toBe("bad")
    expect(new AutomationStorageFailed({ code: "storage", message: "boom" })._tag).toBe("AutomationStorageFailed")
  })
})

describe("contracts/rpc automation payloads", () => {
  const payloadOf = (tag: string) => ExpandRpcs.requests.get(tag)!.payloadSchema

  it.effect("routine create accepts template or custom process", () =>
    Effect.gen(function*() {
      const scope = { ownerId: "person", projectId: "project" }
      const base = {
        scope,
        routineId: "triage",
        configuration: { categories: ["bug"] },
        integrations: [],
        process: {
          schemaVersion: 1,
          kind: "process",
          trigger: { definition: { id: "github:issue-opened", version: 1 }, integration: { id: "github", definition: { id: "github:integration", version: 1 } }, configuration: {} },
          actions: {}
        }
      }
      expect(yield* Schema.decodeUnknownEffect(payloadOf("AutomationRoutineCreate"))(base)).toMatchObject({ routineId: "triage" })
      expect(yield* Schema.decodeUnknownEffect(payloadOf("AutomationRoutineCreate"))({ ...base, template: { id: "github:issue-classification", version: 1 } })).toMatchObject({ routineId: "triage" })
    }))

  it.effect("credential put accepts secret string but list returns only status", () =>
    Effect.gen(function*() {
      const scope = { ownerId: "person", projectId: "project" }
      const put = yield* Schema.decodeUnknownEffect(payloadOf("AutomationCredentialPut"))({ scope, credentialId: "tok", secret: "s3cr3t" })
      expect(put).toMatchObject({ credentialId: "tok", secret: "s3cr3t" })
      const listSuccess = ExpandRpcs.requests.get("AutomationCredentialList")!.successSchema
      const decoded = yield* Schema.decodeUnknownEffect(listSuccess)({ credentials: [{ credentialId: "tok", version: 1, configured: true }] })
      expect(decoded).toMatchObject({ credentials: [{ credentialId: "tok" }] })
      expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(decoded)).toContain("tok")
    }))

  it.effect("run list validates pagination and filters", () =>
    Effect.gen(function*() {
      const scope = { ownerId: "person", projectId: "project" }
      const payload = { scope, limit: 1, routineId: "triage", mode: "live", state: "queued" }
      expect(yield* Schema.decodeUnknownEffect(payloadOf("AutomationRunList"))(payload)).toMatchObject({ limit: 1 })
      expect(yield* Schema.decodeUnknownEffect(payloadOf("AutomationRunList"))({ scope, limit: 100 })).toMatchObject({ limit: 100 })
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(payloadOf("AutomationRunList"))({ scope, limit: 0 })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(payloadOf("AutomationRunList"))({ scope, limit: -5 })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(payloadOf("AutomationRunList"))({ scope, limit: 101 })))).toBe(true)
      const page = ExpandRpcs.requests.get("AutomationRunList")!.successSchema
      expect(yield* Schema.decodeUnknownEffect(page)({ runs: [], cursor: null })).toEqual({ runs: [], cursor: null })
    }))

  it.effect("preview requires routine or inline and returns classified shape", () =>
    Effect.gen(function*() {
      const scope = { ownerId: "person", projectId: "project" }
      const issue = { issueNumber: 7, title: "crash on start" }
      const decision = { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: { label: "type: bug" } }
      const payload = payloadOf("AutomationPreviewClassification")
      const inline = {
        routineId: "triage",
        configuration: { categories: ["bug"] },
        integrations: [],
        process: {
          schemaVersion: 1,
          kind: "process",
          trigger: { definition: { id: "github:issue-opened", version: 1 }, integration: { id: "github", definition: { id: "github:integration", version: 1 } }, configuration: {} },
          actions: {}
        }
      }
      expect(yield* Schema.decodeUnknownEffect(payload)({ scope, routineId: "triage", issue, decision })).toMatchObject({ routineId: "triage" })
      expect(yield* Schema.decodeUnknownEffect(payload)({ scope, inline, issue, decision })).toMatchObject({ inline })
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(payload)({ scope, issue, decision })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(payload)({ scope, routineId: "triage", inline, issue, decision })))).toBe(true)
      const success = ExpandRpcs.requests.get("AutomationPreviewClassification")!.successSchema
      const classified = {
        kind: "classified",
        request: {
          schemaVersion: 1, kind: "jev-request", provider: "opencode-zen", model: "jev", version: "1.13",
          configuration: { routineId: "triage", revision: 1 },
          input: { kind: "input-reference", id: "issue-1" },
          outcomes: ["bug"], data: { issueNumber: 1, title: "t" }
        },
        decision: { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: { label: "type: bug" } },
        latencyMs: 1, outcomeId: "bug", label: "type: bug",
        actions: [{ stepId: "label-bug", arguments: { issueNumber: 1, label: "type: bug" } }],
        executed: false
      }
      expect(yield* Schema.decodeUnknownEffect(success)(classified)).toMatchObject({ kind: "classified", executed: false })
    }))

  it.effect("catalog succeeds with definitions array", () =>
    Effect.gen(function*() {
      const success = ExpandRpcs.requests.get("AutomationCatalog")!.successSchema
      expect(yield* Schema.decodeUnknownEffect(success)({ schemaVersion: 1, kind: "catalog", definitions: [] })).toMatchObject({ kind: "catalog" })
    }))
})
