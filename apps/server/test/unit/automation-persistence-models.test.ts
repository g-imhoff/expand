import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { ActionOutcome, RunState } from "@expand/contracts/automation"
import { Attempt, decode, validateRun } from "../../automation/persistence-models.js"
import { delivery, run, attemptValues, decisionRequest, action, actionResult, failure } from "../fixtures/automation-persistence-fixture.js"

describe("persistence models", () => {
  it.live("accepts exact T01 records and rejects scope/input/authority mismatch", () => Effect.gen(function* () {
    expect(yield* validateRun(run, delivery)).toEqual(run)
    for (const invalid of [
      { ...run, scope: { ...run.scope, ownerId: "other" } },
      { ...run, input: { kind: "input-reference", id: "other" } },
      { ...run, authority: { ...run.authority, configuration: { ...run.configuration, revision: 2 } } }
    ]) expect.soft(Exit.isFailure(yield* Effect.exit(validateRun(invalid, delivery)))).toBe(true)
  }))
})

describe("persistence codecs", () => {
  it.live("preserves every public state/outcome and actual supplied evidence without extensions", () => Effect.gen(function* () {
    for (const state of [{ kind: "queued" }, { kind: "running" }, { kind: "succeeded", result: { actual: true } }, { kind: "unresolved", reason: "no match" }, { kind: "failed", error: failure }, { kind: "cancelled", reason: "caller" }]) expect(yield* decode(RunState, state)).toEqual(state)
    for (const outcome of [{ kind: "planned", stepId: action.id, action: action.action, arguments: decisionRequest.data }, actionResult, { kind: "failed", stepId: action.id, action: action.action, error: failure }, { kind: "skipped", stepId: action.id, action: action.action, reason: "caller skipped" }]) expect(yield* decode(ActionOutcome, outcome)).toEqual(outcome)
    for (const value of attemptValues) expect(yield* decode(Attempt, value)).toEqual(value)
    for (const invalid of [{ ...run, schemaVersion: 2 }, { ...run, extra: "private-fixture-sentinel" }, { ...run, actions: [{ kind: "succeeded", stepId: action.id, action: action.action, result: undefined }] }, { ...run, scope: { ...run.scope, projectId: "other" } }]) {
      const exit = yield* Effect.exit(validateRun(invalid, delivery)); expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).not.toContain("private-fixture-sentinel")
    }
    expect(Exit.isFailure(yield* Effect.exit(decode(Attempt, { ...attemptValues[0]!, attempt: 0 })))).toBe(true)
  }))
})
