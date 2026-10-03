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
import { AutomationRegistry } from "../../automation/registry.js"
import {
  buildGmailClassificationProcess, gmailTemplateReference
} from "@expand/contracts/automation/gmail"
import { makeGmailServerExtension } from "../../automation/gmail-client.js"
import { runEmailClassification } from "../../automation/email-classification.js"
import { loadGmailPollState, markGmailSent, pollGmailInbox } from "../../automation/gmail-poll.js"
import { startGmailStub } from "../fixtures/automation-gmail-stub.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Live = Layer.mergeAll(Configs, Creds, Execs, NodeHttpClient.layerFetch)

const fakeToken = "stub-gmail-oauth-for-tests-only"
const scope = { ownerId: "gmail-owner", projectId: "gmail-project" }
const classification = {
  categories: ["support", "receipts"],
  labels: { support: "Label_support", receipts: "Label_receipts" },
  moves: { receipts: "INBOX" },
  notifications: { onMatch: true, onNoMatch: false }
}
const gmailIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "gmail",
  definition: { id: "gmail:integration" as const, version: 1 as const },
  configuration: {},
  credentials: { oauth: { schemaVersion: 1 as const, kind: "credential-reference" as const, credentialId: "gmail-oauth" } }
}
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const withStub = Effect.acquireRelease(startGmailStub(), (stub) => Effect.sync(() => stub.close()))

const seed = Effect.gen(function*() {
  const credentials = yield* CredentialRepository
  const configurations = yield* ConfigurationRepository
  yield* credentials.putCredential(scope, "gmail-oauth", fakeToken, 0)
  yield* configurations.putIntegration(scope, gmailIntegration, 0)
  const process = yield* buildGmailClassificationProcess("gmail", classification)
  yield* configurations.appendRoutineRevision({
    schemaVersion: 1, kind: "routine-configuration",
    reference: { routineId: "triage", revision: 1 },
    template: gmailTemplateReference, scope,
    configuration: classification, integrations: [gmailIntegration], process
  }, 0, "enabled")
})

describe("gmail poll to classify to label", () => {
  it.live("polls new mail, classifies live, applies labels, and resumes without reprocessing", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setMessages([
      { id: "msg-a", labelIds: ["INBOX"], subject: "Help with login", from: "user@example.com", snippet: "Cannot sign in" },
      { id: "msg-b", labelIds: ["INBOX"], subject: "Invoice attached", from: "billing@example.com", snippet: "See PDF" },
      { id: "msg-self", labelIds: ["SENT"], subject: "Automation reply", from: "me@example.com", snippet: "Sent by us" }
    ])
    yield* seed
    yield* markGmailSent(scope, "gmail", "msg-self")
    const first = yield* pollGmailInbox(scope, "gmail", { baseUrl: stub.baseUrl })
    expect(first.polled).toBe(3)
    expect(first.ingested).toBe(2)
    expect(first.skippedSelf).toBe(1)
    expect([...first.deliveryIds].sort()).toEqual(["gmail:msg-a", "gmail:msg-b"])
    expect(encode(first)).not.toContain("Help with login")
    const executions = yield* ExecutionRepository
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toHaveLength(2)
    const stored = yield* executions.getDelivery(scope, "gmail:msg-a")
    expect(stored?.value.externalId).toBe("msg-a")
    expect(stored?.value.payload).toMatchObject({ messageId: "msg-a" })
    const server = makeGmailServerExtension({ baseUrl: stub.baseUrl })
    const registry = new AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient>()
    yield* registry.register(server.extension)
    const configurations = yield* ConfigurationRepository
    const routine = yield* configurations.getRevision(scope, "triage", 1)
    expect(routine).not.toBeNull()
    const decide = () => Effect.succeed({
      schemaVersion: 1 as const, kind: "selected" as const, outcomeId: "receipts",
      data: { choice: "receipts", probabilities: { support: 0.1, receipts: 0.9 }, confidence: 0.85 }
    })
    const preview = yield* runEmailClassification({
      configuration: routine!, email: { messageId: "msg-a", subject: "Help with login" },
      mode: "preview", decide, registry
    })
    expect(preview.kind).toBe("classified")
    if (preview.kind !== "classified") return
    expect(preview.executed).toBe(false)
    expect(stub.messages.get("msg-a")?.labelIds).toContain("INBOX")
    const live = yield* runEmailClassification({
      configuration: routine!, email: { messageId: "msg-a", subject: "Help with login" },
      mode: "live", decide, registry
    })
    expect(live.kind).toBe("classified")
    if (live.kind !== "classified") return
    expect(live.executed).toBe(true)
    expect(live.results).toEqual([{ stepId: live.actions[0]?.stepId, applied: true }])
    expect(stub.messages.get("msg-a")?.labelIds).toContain("Label_receipts")
    expect(stub.messages.get("msg-a")?.labelIds).not.toContain("INBOX")
    const modifyCalls = stub.calls.filter((call) => call.method === "POST")
    expect(modifyCalls.length).toBeGreaterThan(0)
    expect(modifyCalls[0]?.authorization).toBe(`Bearer ${fakeToken}`)
    expect(encode(modifyCalls.map((call) => call.body))).not.toContain("Help with login")
    expect(encode(modifyCalls.map((call) => call.body))).not.toContain(fakeToken)
    const state = yield* loadGmailPollState(scope, "gmail")
    expect(state.seenIds).toContain("msg-a")
    expect(state.seenIds).toContain("msg-b")
    const second = yield* pollGmailInbox(scope, "gmail", { baseUrl: stub.baseUrl })
    expect(second.polled).toBe(3)
    expect(second.ingested).toBe(0)
    expect(second.skippedSeen).toBe(3)
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toHaveLength(2)
    const resumed = yield* loadGmailPollState(scope, "gmail")
    expect([...resumed.seenIds].sort()).toEqual([...state.seenIds].sort())
  }).pipe(Effect.provide(Live)))
})
