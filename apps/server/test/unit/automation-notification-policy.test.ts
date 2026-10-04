import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import { evaluateNotificationKind } from "../../automation/notification-policy.js"

const failed = { kind: "failed" as const, error: { code: "transient", message: "busy" } }
const unresolved = { kind: "unresolved" as const, reason: "no match" }
const succeeded = { kind: "succeeded" as const, result: { outcomeId: "bug", results: [] } }
const queued = { kind: "queued" as const }

describe("notification preferences", () => {
  it.effect("stays quiet for successful runs under the default configuration", () =>
    Effect.gen(function* () {
      expect(evaluateNotificationKind({}, succeeded)).toBeNull()
      expect(evaluateNotificationKind({ notifications: { onMatch: false, onNoMatch: false } }, succeeded)).toBeNull()
      expect(evaluateNotificationKind(undefined, succeeded)).toBeNull()
    }))
  it.effect("notifies failures regardless of overrides", () =>
    Effect.gen(function* () {
      expect(evaluateNotificationKind({}, failed)).toBe("failure")
      expect(evaluateNotificationKind({ notifications: { onMatch: false, onNoMatch: false } }, failed)).toBe("failure")
    }))
  it.effect("distinguishes unresolved as informational and honors onNoMatch", () =>
    Effect.gen(function* () {
      expect(evaluateNotificationKind({}, unresolved)).toBe("unresolved")
      expect(evaluateNotificationKind({ notifications: { onMatch: false, onNoMatch: true } }, unresolved)).toBe("unresolved")
      expect(evaluateNotificationKind({ notifications: { onMatch: true, onNoMatch: false } }, unresolved)).toBeNull()
    }))
  it.effect("honors onMatch overrides for successful runs", () =>
    Effect.gen(function* () {
      expect(evaluateNotificationKind({ notifications: { onMatch: true, onNoMatch: false } }, succeeded)).toBe("success")
      expect(evaluateNotificationKind({ onMatch: true }, succeeded)).toBe("success")
    }))
  it.effect("ignores incomplete states and stays idempotent across retries", () =>
    Effect.gen(function* () {
      expect(evaluateNotificationKind({}, queued)).toBeNull()
      expect(evaluateNotificationKind({ notifications: { onMatch: true, onNoMatch: true } }, queued)).toBeNull()
      const first = evaluateNotificationKind({ notifications: { onMatch: false, onNoMatch: true } }, unresolved)
      const second = evaluateNotificationKind({ notifications: { onMatch: false, onNoMatch: true } }, unresolved)
      expect(first).toBe("unresolved")
      expect(second).toBe(first)
    }))
})
