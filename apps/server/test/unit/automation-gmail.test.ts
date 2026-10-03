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
  buildGmailClassificationProcess, gmailLabelActionReference, gmailTemplateReference,
  gmailTriggerReference, makeGmailExtension
} from "@expand/contracts/automation/gmail"
import {
  applyGmailLabels, checkGmailLive, checkGmailStatus, makeGmailServerExtension, redactedGmailStatus, resolveGmailToken,
  withoutLabelIds, unionLabelIds
} from "../../automation/gmail-client.js"
import { runEmailClassification } from "../../automation/email-classification.js"
import type { EmailClassificationDecide } from "../../automation/email-classification.js"
import { JevDecisionError } from "../../automation/jev-client.js"
import { formatGmailPollLog, isSelfGmailMessage, markGmailSent, listGmailSentIds } from "../../automation/gmail-poll.js"
import { startGmailStub } from "../fixtures/automation-gmail-stub.js"

const Ready = DatabaseReadyLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })))
const Configs = ConfigurationRepositoryLayer.pipe(Layer.provideMerge(Ready))
const Creds = CredentialRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Execs = ExecutionRepositoryLayer.pipe(Layer.provideMerge(Configs))
const Live = Layer.mergeAll(Creds, Configs, Execs, NodeHttpClient.layerFetch)

const fakeToken = "stub-gmail-oauth-for-tests-only"
const scope = { ownerId: "gmail-owner", projectId: "gmail-project" }
const subject = "Quarterly invoice #4242"
const sender = "billing@example.com"
const snippet = "Amount due next week"
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
const optionsFor = (baseUrl: string) => ({ baseUrl })
const withStub = Effect.acquireRelease(startGmailStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
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
  }, 0, "enabled").pipe(Effect.catch(() => Effect.succeed(1)))
})

const testConfiguration = Effect.gen(function*() {
  const process = yield* buildGmailClassificationProcess("gmail", classification)
  return {
    schemaVersion: 1 as const,
    kind: "routine-configuration" as const,
    reference: { routineId: "triage", revision: 1 as const },
    scope,
    configuration: classification,
    integrations: [gmailIntegration],
    process
  }
})

const testRegistry = Effect.gen(function*() {
  const mutations: Array<{ readonly args: unknown }> = []
  const { extension } = makeGmailExtension((args) =>
    Effect.sync(() => {
      mutations.push({ args })
      return { applied: true }
    })
  )
  const registry = new AutomationRegistry()
  yield* registry.register(extension)
  return { registry, mutations }
})

const receiptsDecide: EmailClassificationDecide = () =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "selected" as const,
    outcomeId: "receipts",
    data: { choice: "receipts", probabilities: { support: 0.1, receipts: 0.88 }, confidence: 0.82 }
  })

const abstainDecide: EmailClassificationDecide = () =>
  Effect.succeed({ schemaVersion: 1 as const, kind: "abstained" as const, reason: "No candidate matched the input (no_match)" })

const failingDecide: EmailClassificationDecide = () =>
  Effect.fail(new JevDecisionError({ code: "transient", message: "Zen overloaded" }))

describe("gmail label mapping", () => {
  it.live("maps the chosen category to add and move labels through one decision path", () => Effect.gen(function*() {
    const configuration = yield* testConfiguration
    const { registry, mutations } = yield* testRegistry
    const email = { messageId: "msg-1", subject, from: sender, snippet, body: "Details" }
    const preview = yield* runEmailClassification({ configuration, email, mode: "preview", decide: receiptsDecide, registry })
    expect(preview.kind).toBe("classified")
    if (preview.kind !== "classified") return
    expect(preview.outcomeId).toBe("receipts")
    expect(preview.label).toBe("Label_receipts")
    expect(preview.executed).toBe(false)
    expect(preview.actions[0]?.arguments).toEqual({ messageId: "msg-1", addLabelIds: ["Label_receipts"], removeLabelIds: ["INBOX"] })
    expect(mutations).toHaveLength(0)
    const liveSetup = yield* testRegistry
    const live = yield* runEmailClassification({ configuration, email, mode: "live", decide: receiptsDecide, registry: liveSetup.registry })
    expect(live.kind).toBe("classified")
    if (live.kind !== "classified") return
    expect(live.executed).toBe(true)
    expect(liveSetup.mutations).toHaveLength(1)
    expect(encode(liveSetup.mutations[0])).not.toContain(subject)
    expect(encode(liveSetup.mutations[0])).not.toContain(sender)
  }).pipe(Effect.provide(Live)))
  it.live("leaves the mailbox unchanged on abstention and records unresolved", () => Effect.gen(function*() {
    const configuration = yield* testConfiguration
    const { registry, mutations } = yield* testRegistry
    const outcome = yield* runEmailClassification({
      configuration, email: { messageId: "msg-2", subject, from: sender }, mode: "live", decide: abstainDecide, registry
    })
    expect(outcome.kind).toBe("unresolved")
    if (outcome.kind !== "unresolved") return
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toContain("no_match")
    expect(mutations).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
  it.live("records a typed retryable failure without fabricating a decision", () => Effect.gen(function*() {
    const configuration = yield* testConfiguration
    const { registry, mutations } = yield* testRegistry
    const outcome = yield* runEmailClassification({
      configuration, email: { messageId: "msg-3" }, mode: "live", decide: failingDecide, registry
    })
    expect(outcome.kind).toBe("failed")
    if (outcome.kind !== "failed") return
    expect(outcome.error.code).toBe("transient")
    expect(mutations).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
})

describe("gmail dedup on message id", () => {
  it.live("treats redeliveries as duplicates and creates nothing new", () => Effect.gen(function*() {
    yield* seed
    const executions = yield* ExecutionRepository
    const delivery = {
      schemaVersion: 1 as const, id: "gmail:msg-dup", scope,
      integration: { id: "gmail", definition: { id: "gmail:integration" as const, version: 1 as const } },
      externalId: "msg-dup", trigger: gmailTriggerReference,
      payload: { messageId: "msg-dup", subject }
    }
    const raw = new TextEncoder().encode(encode({ messageId: "msg-dup" } as Schema.Json))
    const run = {
      schemaVersion: 1 as const, kind: "run" as const, id: "gmail:msg-dup:run:triage", scope,
      configuration: { routineId: "triage", revision: 1 as const },
      input: { kind: "input-reference" as const, id: "gmail:msg-dup" },
      mode: "live" as const,
      authority: {
        schemaVersion: 1 as const, kind: "invocation-authority" as const, scope,
        configuration: { routineId: "triage", revision: 1 as const },
        integrationIds: ["gmail"],
        actionGrants: [{ action: gmailLabelActionReference, integrationId: "gmail", capabilities: ["label"] }]
      },
      state: { kind: "queued" as const }, actions: []
    }
    const target = { jobId: "gmail:msg-dup:job:triage", run }
    const first = yield* executions.ingest({ delivery, raw, targets: [target] })
    const second = yield* executions.ingest({ delivery, raw, targets: [target] })
    expect(second).toEqual(first)
    expect((yield* executions.listRuns(scope, { limit: 10 })).items).toHaveLength(1)
    expect(encode(second)).not.toContain(subject)
  }).pipe(Effect.provide(Live)))
})

describe("gmail self-loop guard", () => {
  it.effect("never classifies messages the automation itself sent", () => Effect.sync(() => {
    expect(isSelfGmailMessage({ id: "a", labelIds: ["SENT"] }, undefined, [])).toBe(true)
    expect(isSelfGmailMessage({ id: "b", labelIds: ["INBOX"] }, undefined, ["b"])).toBe(true)
    expect(isSelfGmailMessage({ id: "c", labelIds: ["INBOX"], from: "Me <me@example.com>" }, "me@example.com", [])).toBe(true)
    expect(isSelfGmailMessage({ id: "d", labelIds: ["INBOX"], from: sender }, "me@example.com", [])).toBe(false)
    expect(isSelfGmailMessage({ id: "e", labelIds: ["INBOX"] }, undefined, [])).toBe(false)
    expect(unionLabelIds(["INBOX"], ["Label_support"])).toEqual(["INBOX", "Label_support"])
    expect(withoutLabelIds(["INBOX", "Label_support"], ["INBOX"])).toEqual(["Label_support"])
  }))
  it.live("tracks sent-message identification explicitly", () => Effect.gen(function*() {
    yield* markGmailSent(scope, "gmail", "msg-sent-1")
    expect(yield* listGmailSentIds(scope, "gmail")).toContain("msg-sent-1")
    expect(isSelfGmailMessage({ id: "msg-sent-1", labelIds: ["INBOX"] }, undefined, yield* listGmailSentIds(scope, "gmail"))).toBe(true)
  }).pipe(Effect.provide(Live)))
  it.effect("formats poll logs without subjects senders or body", () => Effect.sync(() => {
    const line = formatGmailPollLog({ messageId: "msg-9", applied: true })
    expect(line).toContain("msg-9")
    expect(line).not.toContain(subject)
    expect(line).not.toContain(sender)
    expect(line).not.toContain(snippet)
  }))
})

describe("gmail redacted status", () => {
  it.live("resolves OAuth by reference without exposing tokens in redacted reads", () => Effect.gen(function*() {
    const stub = yield* withStub
    void stub
    yield* seed
    expect(yield* resolveGmailToken(scope, gmailIntegration)).toBe(fakeToken)
    const credentials = yield* CredentialRepository
    expect(encode(yield* credentials.list(scope))).not.toContain(fakeToken)
  }).pipe(Effect.provide(Live)))
  it.live("reports status without subjects senders body or tokens", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setMessages([{ id: "m1", labelIds: ["INBOX"], subject, from: sender, snippet }])
    yield* seed
    const status = yield* checkGmailStatus({ token: fakeToken, baseUrl: stub.baseUrl })
    expect(status).toMatchObject({ reachable: true, authOk: true })
    expect(redactedGmailStatus(status)).toEqual(status)
    expect(encode(status)).not.toContain(fakeToken)
    expect(encode(status)).not.toContain(subject)
    expect(encode(status)).not.toContain(sender)
    const live = yield* checkGmailLive({ scope, integration: gmailIntegration, options: optionsFor(stub.baseUrl) })
    expect(live.ok).toBe(true)
    expect(encode(live)).not.toContain(fakeToken)
    expect(encode(live)).not.toContain(subject)
  }).pipe(Effect.provide(Live)))
})

describe("gmail error mapping", () => {
  it.live("maps transport failures without leaking tokens or content", () => Effect.gen(function*() {
    const stub = yield* withStub
    yield* seed
    stub.setReply((call) => {
      if (call.path.includes("/profile")) return { status: 401, body: { error: { message: "Invalid Credentials" } } }
      return { status: 401, body: { error: { message: "Invalid Credentials" } } }
    })
    const status = yield* checkGmailStatus({ token: fakeToken, baseUrl: stub.baseUrl })
    expect(status).toEqual({ reachable: true, authOk: false })
    stub.setReply(() => ({ status: 404, body: { error: { message: "Not Found" } } }))
    const missing = yield* Effect.flip(applyGmailLabels(
      { mailbox: "me", messageId: "gone", addLabelIds: ["Label_support"] }, fakeToken, optionsFor(stub.baseUrl)
    ))
    expect(missing.code).toBe("not-found")
    expect(encode(missing)).not.toContain(fakeToken)
    expect(encode(missing)).not.toContain(subject)
    stub.setReply(() => ({ status: 429, body: { error: { message: "Rate Limit Exceeded" } } }))
    const limited = yield* Effect.flip(applyGmailLabels(
      { mailbox: "me", messageId: "m1", addLabelIds: ["Label_support"] }, fakeToken, { ...optionsFor(stub.baseUrl), maxRetries: 0 }
    ))
    expect(limited.code).toBe("rate-limited")
    stub.setReply(() => ({ status: 500, body: { error: { message: "Backend Error" } } }))
    const failed = yield* Effect.flip(applyGmailLabels(
      { mailbox: "me", messageId: "m1", addLabelIds: ["Label_support"] }, fakeToken, { ...optionsFor(stub.baseUrl), maxRetries: 0 }
    ))
    expect(failed.code).toBe("api-error")
    expect(encode(failed)).not.toContain(fakeToken)
  }).pipe(Effect.provide(Live)))
  it.live("rejects unpermitted mailboxes without network", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: {} }))
    const error = yield* Effect.flip(applyGmailLabels(
      { mailbox: "other@example.com", messageId: "m1", addLabelIds: ["Label_support"] },
      fakeToken, { baseUrl: stub.baseUrl, allowedMailboxes: ["me@example.com"] }
    ))
    expect(error.code).toBe("not-allowed")
    expect(stub.calls).toHaveLength(0)
  }).pipe(Effect.provide(Live)))
})

describe("gmail extension registration", () => {
  it.live("registers gmail definitions alongside reusable email shapes", () => Effect.gen(function*() {
    const stub = yield* withStub
    void stub
    const server = makeGmailServerExtension({})
    const registry = new AutomationRegistry<CredentialRepository | ConfigurationRepository | HttpClient.HttpClient>()
    yield* registry.register(server.extension)
    const kinds = registry.catalog().definitions.map((entry) => entry.definition.id)
    expect(kinds).toContain("gmail:integration")
    expect(kinds).toContain("gmail:message-received")
    expect(kinds).toContain("gmail:label-message")
    expect(kinds).toContain("gmail:email-classification")
    expect(gmailTemplateReference.id).toBe("gmail:email-classification")
  }).pipe(Effect.provide(Live)))
})
