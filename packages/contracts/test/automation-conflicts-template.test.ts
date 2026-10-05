import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { buildPrConflictProcess, prConflictTriggerReference, prResolveActionReference, validateConflictInput } from "@expand/contracts/automation/conflicts"

const integration = {
  schemaVersion: 1, kind: "integration-configuration", id: "github-conflicts",
  definition: { id: "github:pr-conflict-integration", version: 1 },
  configuration: { owner: "octo", repo: "hello", permittedBranches: ["feature/"], protectedBranches: ["develop", "master", "main"], defaultBranch: "develop" },
  credentials: { token: { schemaVersion: 1, kind: "credential-reference", credentialId: "conflict-token" } }
}
const triggerConfig = { owner: "octo", repo: "hello", permittedBranches: ["feature/"], protectedBranches: ["develop", "master", "main"], defaultBranch: "develop" }

describe("pr conflict template", () => {
  it.effect("builds a trigger with one resolve action and validates bindings", () =>
    Effect.gen(function*() {
      const process = yield* buildPrConflictProcess("github-conflicts", triggerConfig)
      expect(process.trigger.definition).toEqual(prConflictTriggerReference)
      expect(process.decision).toBeUndefined()
      const steps = process.actions["triggered"]!
      expect(steps).toHaveLength(1)
      expect(steps[0]!.action).toEqual(prResolveActionReference)
      expect(steps[0]!.bindings["pullNumber"]).toEqual({ kind: "field", source: "trigger", path: ["pullNumber"] })
      const checked = yield* validateConflictInput({ configuration: triggerConfig, integrations: [integration], process })
      expect(checked.process.trigger.definition).toEqual(prConflictTriggerReference)
    }))
})
