import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { buildGithubClassificationProcess, makeGithubExtension } from "@expand/contracts/automation/github"
import { AutomationRegistry } from "../../automation/registry.js"
import {
  runIssueClassification
} from "../../automation/issue-classification.js"
import type { ClassificationDecide } from "../../automation/issue-classification.js"
import { JevDecisionError } from "../../automation/jev-client.js"

const scope = { ownerId: "person", projectId: "project" }
const classification = {
  categories: ["bug", "question"],
  labels: { bug: "type: bug", question: "type: question" },
  notifications: { onMatch: true, onNoMatch: true }
}
const githubIntegration = {
  schemaVersion: 1 as const,
  kind: "integration-configuration" as const,
  id: "github",
  definition: { id: "github:integration" as const, version: 1 as const },
  configuration: { owner: "octo", repo: "hello" },
  credentials: {}
}
const issue = { issueNumber: 7, title: "Boom", body: "Details" }
const Http = NodeHttpClient.layerFetch

const testConfiguration = Effect.gen(function*() {
  const process = yield* buildGithubClassificationProcess("github", classification)
  return {
    schemaVersion: 1 as const,
    kind: "routine-configuration" as const,
    reference: { routineId: "triage", revision: 1 as const },
    scope,
    configuration: classification,
    integrations: [githubIntegration],
    process
  }
})

const testRegistry = Effect.gen(function*() {
  const mutations: Array<{ readonly args: unknown }> = []
  const { extension } = makeGithubExtension((args) =>
    Effect.sync(() => {
      mutations.push({ args })
      return { applied: true }
    })
  )
  const registry = new AutomationRegistry()
  yield* registry.register(extension)
  return { registry, mutations }
})

const bugDecide: ClassificationDecide = () =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "selected" as const,
    outcomeId: "bug",
    data: {
      choice: "bug",
      probabilities: { bug: 0.88, question: 0.1, no_match: 0.02 },
      confidence: 0.81
    }
  })

const abstainDecide: ClassificationDecide = () =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "abstained" as const,
    reason: "No candidate matched the input (no_match)"
  })

const unknownDecide: ClassificationDecide = () =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "selected" as const,
    outcomeId: "elsewhere",
    data: {}
  })

const failingDecide: ClassificationDecide = () =>
  Effect.fail(new JevDecisionError({ code: "transient", message: "Zen overloaded" }))

describe("issue classification mapping", () => {
  it.live("maps the chosen category through label mappings to a validated label action", () =>
    Effect.gen(function*() {
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const outcome = yield* runIssueClassification({ configuration, issue, mode: "preview", decide: bugDecide, registry })
      expect(outcome.kind).toBe("classified")
      if (outcome.kind !== "classified") return
      expect(outcome.outcomeId).toBe("bug")
      expect(outcome.label).toBe("type: bug")
      expect(outcome.executed).toBe(false)
      expect(outcome.actions).toHaveLength(1)
      expect(outcome.actions[0]?.arguments).toEqual({ issueNumber: 7, label: "type: bug" })
      expect(outcome.decision).toEqual({
        schemaVersion: 1,
        kind: "selected",
        outcomeId: "bug",
        data: {
          choice: "bug",
          probabilities: { bug: 0.88, question: 0.1, no_match: 0.02 },
          confidence: 0.81
        }
      })
      expect(typeof outcome.latencyMs).toBe("number")
      expect(mutations).toHaveLength(0)
    }).pipe(Effect.provide(Http))
  )
  it.live("rejects a decision outside the configured categories without mutation", () =>
    Effect.gen(function*() {
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const failure = yield* Effect.flip(
        runIssueClassification({ configuration, issue, mode: "live", decide: unknownDecide, registry })
      )
      expect(failure.code).toBe("invalid-reference")
      expect(mutations).toHaveLength(0)
    }).pipe(Effect.provide(Http))
  )
})

describe("issue classification unresolved", () => {
  it.live("leaves the input unchanged with zero mutations on no_match", () =>
    Effect.gen(function*() {
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const outcome = yield* runIssueClassification({ configuration, issue, mode: "live", decide: abstainDecide, registry })
      expect(outcome.kind).toBe("unresolved")
      if (outcome.kind !== "unresolved") return
      expect(outcome.executed).toBe(false)
      expect(outcome.reason).toContain("no_match")
      expect(outcome.decision).toEqual({
        schemaVersion: 1,
        kind: "abstained",
        reason: "No candidate matched the input (no_match)"
      })
      expect(typeof outcome.latencyMs).toBe("number")
      expect(mutations).toHaveLength(0)
    }).pipe(Effect.provide(Http))
  )
})

describe("issue classification preview equivalence", () => {
  it.live("shares one decision path while preview performs zero mutations", () =>
    Effect.gen(function*() {
      const configuration = yield* testConfiguration
      const seen: Array<{ readonly outcomes: ReadonlyArray<string> }> = []
      const recording: ClassificationDecide = (input) =>
        Effect.gen(function*() {
          seen.push({ outcomes: [...input.request.outcomes] })
          return {
            schemaVersion: 1 as const,
            kind: "selected" as const,
            outcomeId: "question" as const,
            data: {
              choice: "question",
              probabilities: { bug: 0.08, question: 0.9, no_match: 0.02 },
              confidence: 0.84
            }
          }
        })
      const previewSetup = yield* testRegistry
      const preview = yield* runIssueClassification({
        configuration,
        issue,
        mode: "preview",
        decide: recording,
        registry: previewSetup.registry
      })
      const liveSetup = yield* testRegistry
      const live = yield* runIssueClassification({
        configuration,
        issue,
        mode: "live",
        decide: recording,
        registry: liveSetup.registry
      })
      expect(seen).toHaveLength(2)
      expect(seen[0]).toEqual(seen[1])
      expect(seen[0]?.outcomes).toEqual(["bug", "question"])
      expect(preview.kind).toBe("classified")
      expect(live.kind).toBe("classified")
      if (preview.kind !== "classified" || live.kind !== "classified") return
      expect(preview.decision).toEqual(live.decision)
      expect(preview.label).toBe("type: question")
      expect(live.label).toBe("type: question")
      expect(preview.executed).toBe(false)
      expect(live.executed).toBe(true)
      expect(previewSetup.mutations).toHaveLength(0)
      expect(liveSetup.mutations).toHaveLength(1)
      expect(liveSetup.mutations[0]?.args).toEqual({ issueNumber: 7, label: "type: question" })
      expect(live.results).toEqual([{ stepId: live.actions[0]?.stepId, applied: true }])
    }).pipe(Effect.provide(Http))
  )
})

describe("issue classification provider failure", () => {
  it.live("records a typed retryable failure without fabricating a decision", () =>
    Effect.gen(function*() {
      const configuration = yield* testConfiguration
      const { registry, mutations } = yield* testRegistry
      const outcome = yield* runIssueClassification({ configuration, issue, mode: "live", decide: failingDecide, registry })
      expect(outcome.kind).toBe("failed")
      if (outcome.kind !== "failed") return
      expect(outcome.error.code).toBe("transient")
      expect(outcome.error.message).toBe("Zen overloaded")
      expect(typeof outcome.latencyMs).toBe("number")
      expect(outcome.executed).toBe(false)
      expect("decision" in outcome).toBe(false)
      expect(mutations).toHaveLength(0)
    }).pipe(Effect.provide(Http))
  )
})
