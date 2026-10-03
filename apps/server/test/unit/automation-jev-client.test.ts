import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node"
import { deriveSelectedActions } from "@expand/contracts/automation"
import { checkJevLive, classifyJev, dryRunJevRequest, mapZenAnswerToDecision } from "../../automation/jev-client.js"
import type { JevClassifyOptions } from "../../automation/jev-client.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"

const fakeKey = "stub-zen-key-for-tests-only"
const request = {
  schemaVersion: 1 as const, kind: "jev-request" as const,
  provider: "opencode-zen" as const, model: "jev" as const, version: "1.13" as const,
  configuration: { routineId: "routine", revision: 1 },
  input: { kind: "input-reference" as const, id: "input" },
  outcomes: ["billing", "technical"],
  data: "My payouts have been failing for three days and I am losing sales."
}
const descriptions = {
  billing: "Payments, invoicing, or refund problems",
  technical: "Bugs, outages, or integration failures"
}
const withStub = Effect.acquireRelease(startJevStub(), (stub) => Effect.sync(() => stub.close()))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

describe("jev request contracts", () => {
  it.live("builds the Zen choice request from automation outcomes and descriptions", () => Effect.gen(function*() {
    const body = yield* dryRunJevRequest(request, descriptions)
    expect(body.model).toBe("jev-1.13")
    expect(body.state).toBe(request.data)
    const question = body.questions["decision"]
    expect(question?.type).toBe("choice")
    expect(question?.criteria).toEqual({ ...descriptions, no_match: "None of the listed candidates matches the input." })
  }))
  it.live("rejects invalid requests descriptions and options without network", () => Effect.gen(function*() {
    const invalid: ReadonlyArray<readonly [unknown, unknown, JevClassifyOptions?]> = [
      [{ ...request, provider: "other" }, descriptions],
      [{ ...request, version: "1.14" }, descriptions],
      [{ ...request, outcomes: [] }, descriptions],
      [{ ...request, outcomes: ["billing", "billing"] }, descriptions],
      [request, { billing: descriptions.billing }],
      [request, { ...descriptions, billing: "" }],
      [request, descriptions, { timeoutMs: 0 }],
      [request, descriptions, { timeoutMs: 400000 }],
      [request, descriptions, { maxRetries: 6 }],
      [request, descriptions, { endpoint: "" }],
      [request, descriptions, { questionId: "" }]
    ]
    for (const [invalidRequest, invalidDescriptions, options] of invalid) {
      const error = yield* Effect.flip(dryRunJevRequest(invalidRequest, invalidDescriptions, options))
      expect(error.code).toBe("invalid-contract")
    }
    const auth = yield* Effect.flip(classifyJev(request, descriptions, ""))
    expect(auth.code).toBe("auth")
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
})

describe("jev answer mapping", () => {
  it.live("selects outcomes with probabilities and abstains on no match", () => Effect.gen(function*() {
    const selected = yield* mapZenAnswerToDecision(request.outcomes, {
      type: "choice", choice: "billing",
      probabilities: { billing: 0.88, technical: 0.1, no_match: 0.02 }, confidence: 0.81
    })
    expect(selected).toEqual({
      schemaVersion: 1, kind: "selected", outcomeId: "billing",
      data: {
        choice: "billing",
        probabilities: { billing: 0.88, technical: 0.1, no_match: 0.02 }, confidence: 0.81
      }
    })
    for (const choice of ["no_match", "unknown"]) {
      const abstained = yield* mapZenAnswerToDecision(request.outcomes, {
        type: "choice", choice,
        probabilities: { billing: 0.1, technical: 0.1, [choice]: 0.8 }, confidence: 0.72
      })
      expect(abstained).toMatchObject({ schemaVersion: 1, kind: "abstained", reason: expect.any(String) })
    }
  }))
  it.live("rejects answers outside the requested candidates", () => Effect.gen(function*() {
    for (const answer of [
      { type: "choice", choice: "elsewhere", probabilities: { elsewhere: 1 }, confidence: 0.9 },
      { type: "choice", choice: "", probabilities: {}, confidence: 0 },
      { type: "noul", noul: 0.9 },
      { choice: "billing" }
    ]) {
      const error = yield* Effect.flip(mapZenAnswerToDecision(request.outcomes, answer))
      expect(error.code).toBe("invalid-contract")
    }
  }))
  it.live("leaves abstentions unresolved for the automation engine", () => Effect.gen(function*() {
    const abstained = yield* mapZenAnswerToDecision(request.outcomes, {
      type: "choice", choice: "no_match",
      probabilities: { billing: 0.3, technical: 0.3, no_match: 0.4 }, confidence: 0.2
    })
    const process = {
      schemaVersion: 1, kind: "process",
      trigger: {
        definition: { id: "sample:trigger", version: 1 },
        integration: { id: "mail", definition: { id: "sample:integration", version: 1 } },
        configuration: {}
      },
      decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: request.outcomes },
      actions: { billing: [], technical: [] }
    }
    expect(yield* deriveSelectedActions(process, abstained)).toEqual({ kind: "unresolved", reason: expect.any(String), actions: [] })
  }))
})

describe("jev transport behavior", () => {
  it.live("retries transient failures and rate limits with bounded attempts", () => Effect.gen(function*() {
    const stub = yield* withStub
    let calls = 0
    stub.setReply(() => {
      calls += 1
      if (calls < 3) return { status: 500, body: { error: "overloaded" } }
      return { status: 200, body: stubChoiceBody("technical", { billing: 0.1, technical: 0.85, no_match: 0.05 }, 0.78) }
    })
    const result = yield* classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 2 })
    expect(result).toEqual({
      schemaVersion: 1, kind: "selected", outcomeId: "technical",
      data: {
        choice: "technical",
        probabilities: { billing: 0.1, technical: 0.85, no_match: 0.05 }, confidence: 0.78
      }
    })
    expect(stub.calls).toHaveLength(3)
    expect(stub.calls[0]?.authorization).toBe(`Bearer ${fakeKey}`)
    let limitedCalls = 0
    stub.setReply(() => {
      limitedCalls += 1
      if (limitedCalls === 1) return { status: 429, body: { error: "slow down" } }
      return { status: 200, body: stubChoiceBody("billing", { billing: 0.9, technical: 0.08, no_match: 0.02 }, 0.84) }
    })
    const limited = yield* classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 3 })
    expect(limited.kind).toBe("selected")
    expect(limitedCalls).toBe(2)
    expect(stub.calls).toHaveLength(5)
    expect(stub.calls[4]?.authorization).toBe(`Bearer ${fakeKey}`)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
  it.live("fails auth errors without retry and without leaking the key", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 401, body: { error: "invalid key" } }))
    const error = yield* Effect.flip(classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 3 }))
    expect(error.code).toBe("auth")
    expect(error.message).not.toContain(fakeKey)
    expect(encode(error)).not.toContain(fakeKey)
    expect(stub.calls).toHaveLength(1)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
  it.live("rejects malformed and out-of-candidate Zen responses without retry", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: { model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } }))
    const malformed = yield* Effect.flip(classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 2 }))
    expect(malformed.code).toBe("invalid-contract")
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("elsewhere", { elsewhere: 1 }, 0.9) }))
    const outside = yield* Effect.flip(classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 2 }))
    expect(outside.code).toBe("invalid-contract")
    expect(stub.calls).toHaveLength(2)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
  it.live("times out slow decisions within the configured deadline", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("billing", { billing: 1 }, 1), hang: true }))
    const single = yield* Effect.flip(classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 100, maxRetries: 0 }))
    expect(single.code).toBe("timeout")
    expect(stub.calls).toHaveLength(1)
    const retried = yield* Effect.flip(classifyJev(request, descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 100, maxRetries: 1 }))
    expect(retried.code).toBe("timeout")
    expect(stub.calls).toHaveLength(3)
  }).pipe(Effect.provide(NodeHttpClient.layerFetch)))
  it.live("reports live latency against a reachable endpoint", () => Effect.gen(function*() {
    const stub = yield* withStub
    stub.setReply(() => ({ status: 200, body: stubChoiceBody("billing", { billing: 0.92, technical: 0.08 }, 0.87) }))
    const checked = yield* checkJevLive({ apiKey: fakeKey, endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 })
    expect(checked.ok).toBe(true)
    expect(checked.blocked).toBe(false)
    expect(checked.outcomeId).toBe("billing")
    expect(checked.confidence).toBe(0.87)
    expect(typeof checked.latencyMs).toBe("number")
    expect(encode(checked)).not.toContain(fakeKey)
  }).pipe(Effect.provide(Layer.mergeAll(NodeHttpClient.layerFetch, NodeFileSystem.layer))))
})
