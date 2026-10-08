import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { SqlClient } from "effect/sql/SqlClient"
import { NodeHttpClient } from "@effect/platform-node"
import { DatabaseReadyLayer } from "../../migrations/sqlite.js"
import { ConfigurationRepositoryLayer } from "../../automation/configuration-repository.js"
import { CredentialRepository, CredentialRepositoryLayer } from "../../automation/credential-repository.js"
import { AutomationRegistry } from "../../automation/registry.js"
import { buildGmailClassificationProcess, makeGmailExtension } from "@expand/contracts/automation/gmail"
import { runEmailClassification } from "../../automation/email-classification.js"
import type { EmailDecide } from "../../automation/email-classification.js"
import { JevDecisionError } from "../../automation/jev-client.js"
import {
  acknowledgeGmailPoll, checkGmailConnection, getPollHistoryId, hasSeenMessage, isSentMessage, markSeenMessage, markSentMessage,
  organizeGmailMessage, pollGmailInbox, resolveGmailToken, savePollHistoryId, unionLabelIds
} from "../../automation/gmail-connector.js"
import { getMessage, listHistory, listMessages } from "../../automation/gmail-transport.js"
import { startGmailStub } from "../fixtures/automation-gmail-stub.js"
const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configurations = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Credentials = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configurations))
const Live = Layer.mergeAll(Credentials, NodeHttpClient.layerFetch)
const fakeToken = "stub-gmail-token-for-tests-only"
const scope = { ownerId: "gmail-owner", projectId: "gmail-project" }
const integration = {
  schemaVersion: 1, kind: "integration-configuration", id: "gmail",
  definition: { id: "gmail:integration", version: 1 },
  configuration: { mailbox: "me" },
  credentials: { oauth: { schemaVersion: 1, kind: "credential-reference", credentialId: "gmail-oauth" } }
}
const withStub = Effect.acquireRelease(startGmailStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const secretBytes = new TextEncoder().encode(fakeToken)
const oauthJsonBytes = (value: unknown) => new TextEncoder().encode(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value as Schema.Json))
const classification = {
  categories: ["receipts", "action"],
  labels: { receipts: "Label_receipts", action: "Label_action" },
  moves: { receipts: "Label_receipts", action: "INBOX" },
  notifications: { onMatch: true, onNoMatch: true }
}
const gmailIntegrationConfig = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "gmail",
  definition: { id: "gmail:integration" as const, version: 1 as const },
  configuration: { mailbox: "me" },
  credentials: {}
}
const testConfiguration = Effect.gen(function*() {
  const process = yield* buildGmailClassificationProcess("gmail", classification)
  return {
    schemaVersion: 1 as const,
    kind: "routine-configuration" as const,
    reference: { routineId: "inbox", revision: 1 as const },
    scope,
    configuration: classification,
    integrations: [gmailIntegrationConfig],
    process
  }
})
const testRegistry = Effect.gen(function*() {
  const mutations: Array<{ readonly args: unknown }> = []
  const { extension } = makeGmailExtension((args) =>
    Effect.sync(() => {
      mutations.push({ args })
      return { applied: true, moved: true }
    })
  )
  const registry = new AutomationRegistry()
  yield* registry.register(extension)
  return { registry, mutations }
})
const receiptsDecide: EmailDecide = () =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "selected" as const,
    outcomeId: "receipts",
    data: { choice: "receipts" }
  })
const abstainDecide: EmailDecide = () =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "abstained" as const,
    reason: "No candidate matched the input"
  })
const failingDecide: EmailDecide = () =>
  Effect.fail(new JevDecisionError({ code: "transient", message: "Zen overloaded" }))
describe("gmail label union", () => {
  it.effect("preserves existing labels and adds only configured labels idempotently", () =>
    Effect.gen(function* () {
      expect(unionLabelIds(["INBOX"], ["Label_receipts"])).toEqual(["INBOX", "Label_receipts"])
      expect(unionLabelIds(["INBOX", "Label_receipts"], ["Label_receipts"])).toEqual(["INBOX", "Label_receipts"])
      expect(unionLabelIds([], ["a", "b"])).toEqual(["a", "b"])
      expect(unionLabelIds(["a", "b"], [])).toEqual(["a", "b"])
    }))
})
describe("gmail oauth token", () => {
  it.live("resolves a bare access token string", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    const token = yield* resolveGmailToken(scope, integration)
    expect(token).toBe(fakeToken)
    expect(encode({ token })).not.toContain("oauth")
  }).pipe(Effect.provide(Live)))
  it.live("resolves JSON objects with accessToken access_token or token", () => Effect.gen(function* () {
    const credentials = yield* CredentialRepository
    const variants = [
      oauthJsonBytes({ accessToken: fakeToken }),
      oauthJsonBytes({ access_token: fakeToken }),
      oauthJsonBytes({ token: fakeToken })
    ]
    let version = 0
    const first = yield* credentials.getStatus(scope, "gmail-oauth")
    if (first !== null) version = first.version
    else {
      yield* credentials.putCredential(scope, "gmail-oauth", variants[0]!, 0)
      version = 1
    }
    for (const [index, bytes] of variants.entries()) {
      if (index === 0 && version === 1) {
        expect(yield* resolveGmailToken(scope, integration)).toBe(fakeToken)
        continue
      }
      const status = yield* credentials.getStatus(scope, "gmail-oauth")
      yield* credentials.putCredential(scope, "gmail-oauth", bytes, status!.version)
      expect(yield* resolveGmailToken(scope, integration)).toBe(fakeToken)
    }
  }).pipe(Effect.provide(Live)))
})
describe("gmail transport privacy", () => {
  it.live("maps auth failures without leaking token or message content", () => Effect.gen(function* () {
    const stub = yield* withStub
    const subject = "Quarterly invoice 4821"
    const sender = "billing@example.com"
    const body = "Secret body 9981"
    stub.setMessage("msg-1", { threadId: "t-1", historyId: "101", labelIds: ["INBOX"], from: sender, subject, body, snippet: body })
    for (const status of [401, 403, 404] as const) {
      stub.setReply(() => ({ status, body: { message: "stub" } }))
      const error = yield* Effect.flip(listMessages("me", fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }))
      expect(encode(error)).not.toContain(fakeToken)
      expect(encode(error)).not.toContain(subject)
      expect(encode(error)).not.toContain(sender)
      expect(encode(error)).not.toContain(body)
    }
    stub.clearReply()
    const message = yield* getMessage("me", "msg-1", fakeToken, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(message.subject).toBe(subject)
    const errorText = encode({ code: "api", message: "Gmail request failed" })
    expect(errorText).not.toContain(subject)
    expect(errorText).not.toContain(sender)
    expect(errorText).not.toContain(body)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
  it.live("reports connection status without exposing token or content", () => Effect.gen(function* () {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    stub.setMessage("msg-2", { threadId: "t-2", historyId: "102", labelIds: ["INBOX"], from: "a@example.com", subject: "Hello", body: "World", snippet: "World" })
    const ok = yield* checkGmailConnection(scope, integration, { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 })
    expect(ok.ok).toBe(true)
    expect(ok.configured).toBe(true)
    expect(encode(ok)).not.toContain(fakeToken)
    expect(encode(ok)).not.toContain("Hello")
    expect(stub.calls[0]?.authorization).toBe(`Bearer ${fakeToken}`)
  }).pipe(Effect.provide(Live)))
})
describe("gmail poll dedupe and sent tracking", () => {
  it.live("reads every list page and checkpoints the profile snapshot before message reads", () => Effect.gen(function*() {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    stub.setReply((call) => {
      if (call.path.endsWith("/profile")) return { status: 200, body: { historyId: "400" } }
      if (call.path.endsWith("/messages")) return { status: 200, body: { messages: [{ id: "first", threadId: "t-first" }], nextPageToken: "page-2" } }
      if (call.path.includes("pageToken=page-2")) return { status: 200, body: { messages: [{ id: "second", threadId: "t-second" }] } }
      const id = call.path.includes("/first?") ? "first" : "second"
      return { status: 200, body: { id, threadId: `t-${id}`, historyId: "999", labelIds: ["INBOX"], payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "From", value: "shop@example.com" }, { name: "Subject", value: "Receipt" }],
        parts: [{ mimeType: "multipart/alternative", parts: [
          { mimeType: "text/html", body: { data: Buffer.from("<p>Total €12</p>").toString("base64url") } },
          { mimeType: "text/plain", body: { data: Buffer.from("Total €12").toString("base64url") } }
        ] }, { mimeType: "text/plain", filename: "attachment.txt", body: { data: Buffer.from("unrelated attachment").toString("base64url") } }]
      } } }
    })
    const polled = yield* pollGmailInbox(scope, integration, { baseUrl: stub.baseUrl, maxRetries: 0 })
    expect(polled.fresh.map((entry) => entry.id)).toEqual(["first", "second"])
    expect(polled.fresh.map((entry) => entry.body)).toEqual(["Total €12", "Total €12"])
    expect(polled.historyId).toBe("400")
    expect(yield* getPollHistoryId(scope, "gmail")).toBeNull()
    yield* acknowledgeGmailPoll(scope, "gmail", polled)
    expect(yield* getPollHistoryId(scope, "gmail")).toBe("400")
  }).pipe(Effect.provide(Live)))

  it.live("reads all history pages, deduplicates added ids, and preserves the checkpoint when a later page fails", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply((call) => call.path.includes("pageToken=next")
      ? { status: 200, body: { historyId: "500", history: [{ messagesAdded: [{ message: { id: "first", threadId: "t-first" } }, { message: { id: "second", threadId: "t-second" } }] }] } }
      : { status: 200, body: { historyId: "500", nextPageToken: "next", history: [{ messagesAdded: [{ message: { id: "first", threadId: "t-first" } }] }] } })
    const options = { baseUrl: stub.baseUrl, maxRetries: 0 }
    expect((yield* listHistory("me", "400", fakeToken, options)).added.map((entry) => entry.id)).toEqual(["first", "second"])
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    yield* savePollHistoryId(scope, "gmail", "400")
    stub.setReply((call) => call.path.includes("pageToken=next")
      ? { status: 500, body: {} }
      : { status: 200, body: { historyId: "500", nextPageToken: "next", history: [{ messagesAdded: [{ message: { id: "first", threadId: "t-first" } }] }] } })
    expect((yield* Effect.exit(pollGmailInbox(scope, integration, options)))._tag).toBe("Failure")
    expect(yield* getPollHistoryId(scope, "gmail")).toBe("400")
    expect(yield* hasSeenMessage(scope, "gmail", "first")).toBe(false)
  }).pipe(Effect.provide(Live)))

  it.live("resynchronizes an expired history marker and skips messages deleted before retrieval", () => Effect.gen(function*() {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    yield* savePollHistoryId(scope, "gmail", "100")
    stub.setReply((call) => {
      if (call.path.includes("/history?")) return { status: 404, body: {} }
      if (call.path.endsWith("/profile")) return { status: 200, body: { historyId: "500" } }
      if (call.path.endsWith("/messages")) return { status: 200, body: { messages: [{ id: "deleted", threadId: "t-deleted" }] } }
      return { status: 404, body: {} }
    })
    const polled = yield* pollGmailInbox(scope, integration, { baseUrl: stub.baseUrl, maxRetries: 0 })
    expect(polled.fresh).toEqual([])
    expect(yield* getPollHistoryId(scope, "gmail")).toBe("100")
    yield* acknowledgeGmailPoll(scope, "gmail", polled)
    expect(yield* getPollHistoryId(scope, "gmail")).toBe("500")
  }).pipe(Effect.provide(Live)))

  it.live("deduplicates on stable message ids and skips self-sent mail", () => Effect.gen(function* () {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    const sql = yield* SqlClient
    void sql
    stub.setHistoryId("200")
    stub.setMessage("msg-seen", { threadId: "t-seen", historyId: "201", labelIds: ["INBOX"], from: "news@example.com", subject: "News", body: "Body", snippet: "Body" })
    stub.setMessage("msg-sent", { threadId: "t-sent", historyId: "202", labelIds: ["INBOX", "SENT"], from: "me@example.com", subject: "Self", body: "Self body", snippet: "Self" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const first = yield* pollGmailInbox(scope, integration, options)
    expect(first.fresh.map((entry) => entry.id).sort()).toEqual(["msg-seen"])
    expect(first.skippedSent).toBe(1)
    expect(yield* hasSeenMessage(scope, "gmail", "msg-seen")).toBe(false)
    yield* acknowledgeGmailPoll(scope, "gmail", first)
    expect(yield* hasSeenMessage(scope, "gmail", "msg-seen")).toBe(true)
    expect(yield* isSentMessage(scope, "msg-sent")).toBe(true)
    stub.setHistoryId("203")
    const second = yield* pollGmailInbox(scope, integration, options)
    expect(second.fresh).toEqual([])
    expect(second.skippedSeen).toBeGreaterThanOrEqual(1)
    yield* markSentMessage(scope, "msg-seen")
    expect(yield* isSentMessage(scope, "msg-seen")).toBe(true)
    yield* markSeenMessage(scope, "gmail", "msg-extra")
    expect(yield* hasSeenMessage(scope, "gmail", "msg-extra")).toBe(true)
  }).pipe(Effect.provide(Live)))
})
describe("gmail email classification preview and abstention", () => {
  it.live("previews through the same decision path without mutating the mailbox", () =>
    Effect.gen(function*() {
      const stub = yield* withStub
      stub.setMessage("msg-preview", { threadId: "t-preview", historyId: "301", labelIds: ["INBOX"], from: "shop@example.com", subject: "Receipt", body: "Total", snippet: "Total" })
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const outcome = yield* runEmailClassification({ configuration, email: { messageId: "msg-preview", threadId: "t-preview", from: "shop@example.com", subject: "Receipt", body: "Total" }, mode: "preview", decide: receiptsDecide, registry })
      expect(outcome.kind).toBe("classified")
      if (outcome.kind !== "classified") return
      expect(outcome.outcomeId).toBe("receipts")
      expect(outcome.label).toBe("Label_receipts")
      expect(outcome.moveTo).toBe("Label_receipts")
      expect(outcome.executed).toBe(false)
      expect(outcome.results).toEqual([])
      expect(mutations).toHaveLength(0)
      expect(stub.calls.filter((call) => call.method === "POST").length).toBe(0)
      expect(outcome.request.data).toEqual({ messageId: "msg-preview", threadId: "t-preview", from: "shop@example.com", subject: "Receipt", body: "Total" })
    }).pipe(Effect.provide(NodeHttpClient.layerFetch))
  )
  it.live("leaves the mailbox unchanged on abstention and records unresolved", () =>
    Effect.gen(function*() {
      const stub = yield* withStub
      stub.setMessage("msg-abs", { threadId: "t-abs", historyId: "302", labelIds: ["INBOX"], from: "x@example.com", subject: "Mystery", body: "Unknown", snippet: "Unknown" })
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const before = stub.calls.length
      const outcome = yield* runEmailClassification({ configuration, email: { messageId: "msg-abs", threadId: "t-abs", from: "x@example.com", subject: "Mystery", body: "Unknown" }, mode: "live", decide: abstainDecide, registry })
      expect(outcome.kind).toBe("unresolved")
      if (outcome.kind !== "unresolved") return
      expect(outcome.executed).toBe(false)
      expect(mutations).toHaveLength(0)
      expect(stub.calls.length).toBe(before)
      expect(stub.getMessageLabels("msg-abs")).toEqual(["INBOX"])
    }).pipe(Effect.provide(NodeHttpClient.layerFetch))
  )
  it.live("fails decisions without mutation", () =>
    Effect.gen(function*() {
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const outcome = yield* runEmailClassification({ configuration, email: { messageId: "m", threadId: "t", from: "a", subject: "s", body: "b" }, mode: "live", decide: failingDecide, registry })
      expect(outcome.kind).toBe("failed")
      expect(mutations).toHaveLength(0)
    }).pipe(Effect.provide(NodeHttpClient.layerFetch))
  )
})
describe("gmail organize idempotency", () => {
  it.live("applies labels once and skips already labeled mail", () => Effect.gen(function* () {
    const stub = yield* withStub
    const credentials = yield* CredentialRepository
    yield* credentials.putCredential(scope, "gmail-oauth", secretBytes, 0)
    stub.setMessage("msg-org", { threadId: "t-org", historyId: "401", labelIds: ["INBOX"], from: "s@example.com", subject: "S", body: "B", snippet: "B" })
    const options = { baseUrl: stub.baseUrl, timeoutMs: 5000, maxRetries: 0 }
    const first = yield* organizeGmailMessage(scope, integration, "msg-org", "Label_receipts", "Label_receipts", options)
    expect(first.applied).toBe(true)
    expect(stub.getMessageLabels("msg-org")).toContain("Label_receipts")
    const callsAfterFirst = stub.calls.length
    const second = yield* organizeGmailMessage(scope, integration, "msg-org", "Label_receipts", "Label_receipts", options)
    expect(second.applied).toBe(true)
    expect(second.moved).toBe(false)
    expect(stub.calls.length).toBeGreaterThan(callsAfterFirst)
  }).pipe(Effect.provide(Live)))
})
