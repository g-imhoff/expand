import { it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import {
  buildGmailClassificationProcess, emailOrganizeActionReference, emailTriggerReference,
  validateGmailClassificationInput
} from "@expand/contracts/automation/gmail"
import { validateProcess } from "@expand/contracts/automation/process"
import type { ProcessDefinition } from "@expand/contracts/automation/process"
type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
const integration = {
  schemaVersion: 1, kind: "integration-configuration", id: "gmail",
  definition: { id: "gmail:integration", version: 1 },
  configuration: { mailbox: "me" },
  credentials: { oauth: { schemaVersion: 1, kind: "credential-reference", credentialId: "gmail-oauth" } }
}
const classification = {
  categories: ["receipts", "action"],
  labels: { receipts: "Label_receipts", action: "Label_action" },
  moves: { receipts: "Label_receipts", action: "INBOX" },
  notifications: { onMatch: true, onNoMatch: false }
}
const fail = Effect.fn("Test.fail")(function*<A, E>(effect: Effect.Effect<A, E>, codes: ReadonlyArray<string> = ["invalid-reference", "invalid-contract"]) {
  const exit = yield* effect.pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(codes).toContain(String((Cause.squash(exit.cause) as { code?: string }).code ?? Cause.squash(exit.cause)))
})
const failRef = Effect.fn("Test.failRef")(function*<A, E>(effect: Effect.Effect<A, E>) {
  yield* fail(effect, ["invalid-reference"])
})
const build = (input: unknown = classification, integrationId: unknown = "gmail") =>
  buildGmailClassificationProcess(integrationId, input)
const clone = (process: ProcessDefinition): Mutable<ProcessDefinition> =>
  structuredClone(process) as Mutable<ProcessDefinition>
const validInput = (process: unknown) => ({ configuration: classification, integrations: [integration], process })
describe("gmail email classification template", () => {
  it.effect("builds one reusable email trigger with one organize action per outcome", () =>
    Effect.gen(function*() {
      const process = yield* build()
      expect(yield* validateProcess(process)).toEqual(process)
      expect(process.trigger.definition).toEqual(emailTriggerReference)
      expect(process.decision?.outcomes).toEqual(["receipts", "action"])
      expect(Object.keys(process.actions).sort()).toEqual(["action", "receipts"])
      for (const category of ["receipts", "action"] as const) {
        const steps = process.actions[category]!
        expect(steps).toHaveLength(1)
        expect(steps[0]!.action).toEqual(emailOrganizeActionReference)
        expect(steps[0]!.bindings["label"]).toEqual({ kind: "literal", value: classification.labels[category] })
        expect(steps[0]!.bindings["moveTo"]).toEqual({ kind: "literal", value: classification.moves[category] })
      }
      expect(yield* validateGmailClassificationInput(validInput(process))).toMatchObject({ process })
    }))
  it.effect("accepts abstention as the unresolved path and keeps label mappings", () =>
    Effect.gen(function*() {
      const process = yield* build()
      const step = process.actions["receipts"]![0]!
      expect(step.bindings["messageId"]).toEqual({ kind: "field", source: "trigger", path: ["messageId"] })
      expect(yield* validateGmailClassificationInput(validInput(process))).toMatchObject({
        classification: { notifications: { onMatch: true, onNoMatch: false } }
      })
    }))
  it.effect("rejects bad categories, mappings, triggers and actions", () =>
    Effect.gen(function*() {
      const process = clone(yield* build())
      for (const categories of [[], ["receipts", "receipts"], [""]] as const) yield* fail(build({ ...classification, categories: [...categories] }))
      yield* fail(build({ ...classification, labels: { receipts: "Label_receipts" } }))
      yield* fail(build({ ...classification, moves: { receipts: "Label_receipts" } }))
      const extraLabel = yield* build({ ...classification, labels: { receipts: "Label_receipts", action: "Label_action", extra: "Label_extra" } })
      void extraLabel
      for (const labels of [{ receipts: "Label_receipts" }, { receipts: "Label_receipts", action: "Label_action", extra: "Label_extra" }] as const) {
        yield* fail(validateGmailClassificationInput({ configuration: { ...classification, labels, moves: classification.moves }, integrations: [integration], process }))
      }
      const triggerMismatch = clone(process)
      triggerMismatch.trigger.definition = { ...emailTriggerReference, version: 2 }
      yield* fail(validateGmailClassificationInput(validInput(triggerMismatch)))
      const unknownAction = clone(process)
      unknownAction.actions["receipts"]![0]!.action = { ...emailOrganizeActionReference, version: 2 }
      yield* fail(validateGmailClassificationInput(validInput(unknownAction)))
      const missingBinding = clone(process)
      missingBinding.actions["receipts"]![0]!.bindings = { label: { kind: "literal", value: "Label_receipts" } }
      yield* fail(validateGmailClassificationInput(validInput(missingBinding)))
      const wrongLabel = clone(process)
      wrongLabel.actions["receipts"]![0]!.bindings["label"] = { kind: "literal", value: "Label_wrong" }
      yield* fail(validateGmailClassificationInput(validInput(wrongLabel)))
      const multiStep = clone(process)
      multiStep.actions["receipts"] = [...multiStep.actions["receipts"]!, ...multiStep.actions["receipts"]!]
      yield* failRef(validateGmailClassificationInput(validInput(multiStep)))
    }))
  it.effect("rejects foreign integrations and duplicate steps", () =>
    Effect.gen(function*() {
      const process = yield* build()
      const duplicate = clone(process)
      duplicate.actions["action"]![0]!.id = duplicate.actions["receipts"]![0]!.id
      yield* fail(validateProcess(duplicate))
      yield* fail(validateGmailClassificationInput(validInput(duplicate)))
      const foreign = clone(process)
      foreign.actions["receipts"]![0]!.integration = { id: "missing", definition: { id: "gmail:integration", version: 1 } }
      yield* fail(validateGmailClassificationInput(validInput(foreign)))
    }))
})
