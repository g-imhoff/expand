import { it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { describe, expect } from "vitest"
import {
  buildGmailClassificationProcess, gmailLabelActionReference, gmailTriggerReference,
  validateGmailClassificationInput
} from "@expand/contracts/automation/gmail"
import { validateProcess } from "@expand/contracts/automation/process"
import type { ProcessDefinition } from "@expand/contracts/automation/process"

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
const integration = {
  schemaVersion: 1, kind: "integration-configuration", id: "gmail",
  definition: { id: "gmail:integration", version: 1 },
  configuration: {},
  credentials: { oauth: { schemaVersion: 1, kind: "credential-reference", credentialId: "gmail-oauth" } }
}
const classification = {
  categories: ["support", "receipts"],
  labels: { support: "Label_support", receipts: "Label_receipts" },
  moves: { receipts: "INBOX" },
  notifications: { onMatch: true, onNoMatch: false }
}
const fail = Effect.fn("Test.fail")(function*<A, E>(effect: Effect.Effect<A, E>) {
  expect(Result.isFailure(yield* effect.pipe(Effect.result))).toBe(true)
})
const build = (input: unknown = classification, integrationId: unknown = "gmail") =>
  buildGmailClassificationProcess(integrationId, input)
const clone = (process: ProcessDefinition): Mutable<ProcessDefinition> =>
  structuredClone(process) as Mutable<ProcessDefinition>
const validInput = (process: unknown) => ({ configuration: classification, integrations: [integration], process })

describe("gmail classification template", () => {
  it.effect("builds one trigger with an optional Jev decision and one label action per outcome", () =>
    Effect.gen(function*() {
      const process = yield* build()
      expect(yield* validateProcess(process)).toEqual(process)
      expect(process.trigger.definition).toEqual(gmailTriggerReference)
      expect(process.decision?.outcomes).toEqual(["support", "receipts"])
      expect(Object.keys(process.actions).sort()).toEqual(["receipts", "support"])
      for (const category of ["support", "receipts"] as const) {
        const steps = process.actions[category]!
        expect(steps).toHaveLength(1)
        expect(steps[0]!.action).toEqual(gmailLabelActionReference)
        expect(steps[0]!.bindings["addLabelIds"]).toEqual({ kind: "literal", value: [classification.labels[category]] })
      }
      expect(process.actions["receipts"]![0]!.bindings["removeLabelIds"]).toEqual({ kind: "literal", value: ["INBOX"] })
      expect(process.actions["support"]![0]!.bindings["removeLabelIds"]).toBeUndefined()
      expect(yield* validateGmailClassificationInput(validInput(process))).toMatchObject({ process })
    }))
  it.effect("accepts abstention as the unresolved path and keeps literal labels mapped", () =>
    Effect.gen(function*() {
      const process = yield* build()
      const support = process.actions["support"]![0]!
      expect(support.bindings["messageId"]).toEqual({ kind: "field", source: "trigger", path: ["messageId"] })
      expect(yield* validateGmailClassificationInput(validInput(process))).toMatchObject({
        classification: { notifications: { onMatch: true, onNoMatch: false } }
      })
    }))
  it.effect("rejects bad categories, label mappings, triggers, actions and notification preferences", () =>
    Effect.gen(function*() {
      const process = clone(yield* build())
      for (const categories of [[], ["support", "support"], [""]] as const) yield* fail(build({ ...classification, categories: [...categories] }))
      yield* fail(build({ ...classification, labels: { support: "Label_support" } }))
      yield* fail(build({ ...classification, labels: { support: "", receipts: "Label_receipts" } }))
      const extraLabel = yield* build({ ...classification, labels: { support: "Label_support", receipts: "Label_receipts", extra: "Label_extra" } })
      for (const labels of [{ support: "Label_support" }, { support: "Label_support", receipts: "Label_receipts", extra: "Label_extra" }] as const) {
        yield* fail(validateGmailClassificationInput({ configuration: { ...classification, labels }, integrations: [integration], process }))
      }
      yield* fail(build(classification, ""))
      const triggerMismatch = clone(process)
      triggerMismatch.trigger.definition = { ...gmailTriggerReference, version: 2 }
      yield* fail(validateGmailClassificationInput(validInput(triggerMismatch)))
      const triggerConfig = clone(process)
      triggerConfig.trigger.configuration = { unexpected: true }
      yield* fail(validateGmailClassificationInput(validInput(triggerConfig)))
      const unknownAction = clone(process)
      unknownAction.actions["support"]![0]!.action = { ...gmailLabelActionReference, version: 2 }
      yield* fail(validateGmailClassificationInput(validInput(unknownAction)))
      const missingBinding = clone(process)
      missingBinding.actions["support"]![0]!.bindings = { addLabelIds: { kind: "literal", value: ["Label_support"] } }
      yield* fail(validateGmailClassificationInput(validInput(missingBinding)))
      const wrongLabel = clone(process)
      wrongLabel.actions["support"]![0]!.bindings["addLabelIds"] = { kind: "literal", value: ["Label_wrong"] }
      yield* fail(validateGmailClassificationInput(validInput(wrongLabel)))
      const missingOutcome = clone(process)
      missingOutcome.actions = { support: missingOutcome.actions["support"]! }
      yield* fail(validateGmailClassificationInput(validInput(missingOutcome)))
      const extraOutcome = { ...clone(process), decision: { ...process.decision!, outcomes: ["support", "receipts", "docs"] } }
      yield* fail(validateGmailClassificationInput(validInput(extraOutcome)))
      void extraLabel
    }))
})
