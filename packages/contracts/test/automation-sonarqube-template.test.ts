import { it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { describe, expect } from "vitest"
import {
  buildSonarAutoFixProcess, sonarFetchActionReference, sonarFindingTriggerReference,
  sonarVerifyActionReference, validateSonarAutoFixInput
} from "@expand/contracts/automation/sonarqube"
import { skillActionReference } from "@expand/contracts/automation/skills"
import { codingIntegrationReference } from "@expand/contracts/automation/coding"
import { validateProcess } from "@expand/contracts/automation/process"
import type { ProcessDefinition } from "@expand/contracts/automation/process"

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T
const sonarIntegration = {
  schemaVersion: 1, kind: "integration-configuration", id: "sonar",
  definition: { id: "sonarqube:integration", version: 1 },
  configuration: { baseUrl: "http://127.0.0.1:9000", projectKey: "test-project" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "sonar-token" } }
}
const codingIntegration = {
  schemaVersion: 1, kind: "integration-configuration", id: "coding",
  definition: { id: "coding-agent:integration", version: 1 },
  configuration: { repository: "octo/hello" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "coding-token" } }
}
const configuration = {
  repairSkillId: "sample-write-file",
  repairInputs: { content: "fix-finding" }
}
const fail = Effect.fn("Test.fail")(function*<A, E>(effect: Effect.Effect<A, E>) {
  const exit = yield* effect.pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(String((Cause.squash(exit.cause) as { code?: string }).code ?? "")).not.toBe("")
})
const build = (sonarId: unknown = "sonar", codingId: unknown = "coding", input: unknown = configuration) =>
  buildSonarAutoFixProcess(sonarId, codingId, input)
const clone = (process: ProcessDefinition): Mutable<ProcessDefinition> =>
  structuredClone(process) as Mutable<ProcessDefinition>
const validInput = (process: unknown, config: unknown = configuration) => ({ configuration: config, integrations: [sonarIntegration, codingIntegration], process })

describe("sonarqube auto fix template", () => {
  it.effect("builds fetch, repair and verify steps with the finding trigger", () =>
    Effect.gen(function*() {
      const process = yield* build()
      expect(yield* validateProcess(process)).toEqual(process)
      expect(process.trigger.definition).toEqual(sonarFindingTriggerReference)
      expect(process.decision).toBeUndefined()
      expect(Object.keys(process.actions)).toEqual(["triggered"])
      const steps = process.actions["triggered"]!
      expect(steps).toHaveLength(3)
      expect(steps[0]!.action).toEqual(sonarFetchActionReference)
      expect(steps[1]!.action).toEqual(skillActionReference)
      expect(steps[2]!.action).toEqual(sonarVerifyActionReference)
      expect(steps[0]!.bindings["issueKey"]).toEqual({ kind: "field", source: "trigger", path: ["issueKey"] })
      expect(steps[1]!.bindings["skillId"]).toEqual({ kind: "field", source: "configuration", path: ["repairSkillId"] })
      expect(steps[1]!.bindings["inputs"]).toEqual({ kind: "field", source: "configuration", path: ["repairInputs"] })
      expect(steps[2]!.bindings["issueKey"]).toEqual({ kind: "field", source: "trigger", path: ["issueKey"] })
      expect(yield* validateSonarAutoFixInput(validInput(process))).toMatchObject({ process })
    }))
  it.effect("supports optional agent kind and timeout bindings", () =>
    Effect.gen(function*() {
      const withOptional = { ...configuration, agentKind: "opencode", timeoutMs: 8000 }
      const process = yield* build("sonar", "coding", withOptional)
      const steps = process.actions["triggered"]!
      expect(steps[1]!.bindings["agentKind"]).toEqual({ kind: "field", source: "configuration", path: ["agentKind"] })
      expect(steps[1]!.bindings["timeoutMs"]).toEqual({ kind: "field", source: "configuration", path: ["timeoutMs"] })
      expect(yield* validateSonarAutoFixInput({ configuration: withOptional, integrations: [sonarIntegration, codingIntegration], process })).toMatchObject({ process })
    }))
  it.effect("rejects bad integrations, triggers, steps and bindings", () =>
    Effect.gen(function*() {
      const process = clone(yield* build())
      yield* fail(build("", "coding", configuration))
      yield* fail(build("sonar", "", configuration))
      yield* fail(build("sonar", "coding", { repairSkillId: "", repairInputs: { content: "x" } }))
      const triggerMismatch = clone(process)
      triggerMismatch.trigger.definition = { ...sonarFindingTriggerReference, version: 2 }
      yield* fail(validateSonarAutoFixInput(validInput(triggerMismatch)))
      const withDecision = clone(process)
      withDecision.decision = { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: ["fixed"] }
      yield* fail(validateSonarAutoFixInput(validInput(withDecision)))
      const wrongOrder = clone(process)
      const first = wrongOrder.actions["triggered"]![0]!
      wrongOrder.actions["triggered"]![0] = wrongOrder.actions["triggered"]![1]!
      wrongOrder.actions["triggered"]![1] = first
      yield* fail(validateSonarAutoFixInput(validInput(wrongOrder)))
      const missingCoding = { configuration, integrations: [sonarIntegration], process }
      yield* fail(validateSonarAutoFixInput(missingCoding))
      const foreign = clone(process)
      foreign.actions["triggered"]![0]!.integration = { id: "missing", definition: { id: "sonarqube:integration", version: 1 } }
      yield* fail(validateSonarAutoFixInput(validInput(foreign)))
      const badRepairAction = clone(process)
      badRepairAction.actions["triggered"]![1]!.action = { ...skillActionReference, version: 2 }
      yield* fail(validateSonarAutoFixInput(validInput(badRepairAction)))
      const badBinding = clone(process)
      badBinding.actions["triggered"]![0]!.bindings = { issueKey: { kind: "literal", value: "issue-1" } }
      yield* fail(validateSonarAutoFixInput(validInput(badBinding)))
      const missingVerify = clone(process)
      missingVerify.actions["triggered"] = missingVerify.actions["triggered"]!.slice(0, 2)
      yield* fail(validateSonarAutoFixInput(validInput(missingVerify)))
      expect(codingIntegrationReference.id).toBe("coding-agent:integration")
    }))
})
