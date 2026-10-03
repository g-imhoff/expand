import { it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import {
  buildGithubClassificationProcess, githubLabelActionReference, githubTriggerReference,
  validateClassificationInput
} from "@expand/contracts/automation/github"
import { validateProcess } from "@expand/contracts/automation/process"
import type { ProcessDefinition } from "@expand/contracts/automation/process"

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
const integration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github",
  definition: { id: "github:integration", version: 1 },
  configuration: { owner: "octo", repo: "hello" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "github-token" } }
}
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
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
const build = (input: unknown = classification, integrationId: unknown = "github") =>
  buildGithubClassificationProcess(integrationId, input)
const clone = (process: ProcessDefinition): Mutable<ProcessDefinition> =>
  structuredClone(process) as Mutable<ProcessDefinition>
const validInput = (process: unknown) => ({ configuration: classification, integrations: [integration], process })

describe("github classification template", () => {
  it.effect("builds one trigger with an optional Jev decision and one label action per outcome", () =>
    Effect.gen(function*() {
      const process = yield* build()
      expect(yield* validateProcess(process)).toEqual(process)
      expect(process.trigger.definition).toEqual(githubTriggerReference)
      expect(process.decision?.outcomes).toEqual(["bug", "question"])
      expect(Object.keys(process.actions).sort()).toEqual(["bug", "question"])
      for (const category of ["bug", "question"] as const) {
        const steps = process.actions[category]!
        expect(steps).toHaveLength(1)
        expect(steps[0]!.action).toEqual(githubLabelActionReference)
        expect(steps[0]!.bindings["label"]).toEqual({ kind: "literal", value: classification.labels[category] })
      }
      expect(yield* validateClassificationInput(validInput(process))).toMatchObject({ process })
    }))
  it.effect("accepts abstention as the unresolved path and keeps literal labels mapped", () =>
    Effect.gen(function*() {
      const process = yield* build()
      const bug = process.actions["bug"]![0]!
      expect(bug.bindings["issueNumber"]).toEqual({ kind: "field", source: "trigger", path: ["issueNumber"] })
      expect(yield* validateClassificationInput(validInput(process))).toMatchObject({
        classification: { notifications: { onMatch: true, onNoMatch: false } }
      })
    }))
  it.effect("rejects bad categories, label mappings, triggers, actions and notification preferences", () =>
    Effect.gen(function*() {
      const process = clone(yield* build())
      for (const categories of [[], ["bug", "bug"], [""]] as const) yield* fail(build({ ...classification, categories: [...categories] }))
      yield* fail(build({ ...classification, labels: { bug: "type: bug" } }))
      yield* fail(build({ ...classification, labels: { bug: "", question: "type: question" } }))
      const extraLabel = yield* build({ ...classification, labels: { bug: "type: bug", question: "type: question", extra: "type: extra" } })
      for (const labels of [{ bug: "type: bug" }, { bug: "type: bug", question: "type: question", extra: "type: extra" }, { bug: "", question: "type: question" }] as const) {
        yield* fail(validateClassificationInput({ configuration: { ...classification, labels }, integrations: [integration], process }))
      }
      yield* fail(validateClassificationInput({ configuration: { ...classification, labels: { bug: "type: bug", question: "type: question", extra: "type: extra" } }, integrations: [integration], process: extraLabel }))
      for (const notifications of [{ onMatch: "yes" }, { onMatch: true }, { onMatch: true, onNoMatch: null }] as const) {
        yield* fail(build({ ...classification, notifications }))
      }
      yield* fail(build(classification, ""))
      const triggerMismatch = clone(process)
      triggerMismatch.trigger.definition = { ...githubTriggerReference, version: 2 }
      yield* fail(validateClassificationInput(validInput(triggerMismatch)))
      const triggerConfig = clone(process)
      triggerConfig.trigger.configuration = { unexpected: true }
      yield* fail(validateClassificationInput(validInput(triggerConfig)))
      const unknownAction = clone(process)
      unknownAction.actions["bug"]![0]!.action = { ...githubLabelActionReference, version: 2 }
      yield* fail(validateClassificationInput(validInput(unknownAction)))
      const missingBinding = clone(process)
      missingBinding.actions["bug"]![0]!.bindings = { label: { kind: "literal", value: "type: bug" } }
      yield* fail(validateClassificationInput(validInput(missingBinding)))
      const wrongLabel = clone(process)
      wrongLabel.actions["bug"]![0]!.bindings["label"] = { kind: "literal", value: "type: wrong" }
      yield* fail(validateClassificationInput(validInput(wrongLabel)))
      const missingOutcome = clone(process)
      missingOutcome.actions = { bug: missingOutcome.actions["bug"]! }
      yield* fail(validateClassificationInput(validInput(missingOutcome)))
      const extraOutcome = { ...clone(process), decision: { ...process.decision!, outcomes: ["bug", "question", "docs"] } }
      yield* fail(validateClassificationInput(validInput(extraOutcome)))
      const multiStep = clone(process)
      multiStep.actions["bug"] = [...multiStep.actions["bug"]!, ...multiStep.actions["bug"]!]
      yield* failRef(validateClassificationInput(validInput(multiStep)))
      const fieldLabel = clone(process)
      fieldLabel.actions["bug"]![0]!.bindings = { issueNumber: { kind: "literal", value: 7 }, label: { kind: "field", source: "trigger", path: ["issueNumber"] } }
      yield* failRef(validateClassificationInput(validInput(fieldLabel)))
      const extraBinding = clone(process)
      extraBinding.actions["bug"]![0]!.bindings = { ...extraBinding.actions["bug"]![0]!.bindings, extra: { kind: "literal", value: "x" } }
      yield* failRef(validateClassificationInput(validInput(extraBinding)))
    }))
  it.effect("rejects loop attempts, graph keys, duplicate steps and foreign integrations", () =>
    Effect.gen(function*() {
      const process = yield* build()
      for (const extra of [{ loops: [{ from: "bug", to: "bug" }] }, { graph: {} }, { expression: "trigger.issueNumber + 1" }, { triggers: [process.trigger] }]) {
        yield* fail(validateProcess({ ...process, ...extra }))
        yield* fail(validateClassificationInput(validInput({ ...process, ...extra })))
      }
      const duplicate = clone(process)
      duplicate.actions["question"]![0]!.id = duplicate.actions["bug"]![0]!.id
      yield* fail(validateProcess(duplicate))
      yield* fail(validateClassificationInput(validInput(duplicate)))
      const foreign = clone(process)
      foreign.actions["bug"]![0]!.integration = { id: "missing", definition: { id: "github:integration", version: 1 } }
      yield* fail(validateClassificationInput(validInput(foreign)))
    }))
})
