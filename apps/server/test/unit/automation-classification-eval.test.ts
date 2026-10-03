import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Config, Data, DateTime, Effect, FileSystem, Layer, Option, Path } from "effect"
import { describe, expect } from "vitest"
import { buildGithubClassificationProcess, makeGithubExtension } from "@expand/contracts/automation/github"
import { AutomationRegistry } from "../../automation/registry.js"
import { runIssueClassification } from "../../automation/issue-classification.js"
import type { ClassificationDecide } from "../../automation/issue-classification.js"
import { classifyJev, resolveZenApiKey } from "../../automation/jev-client.js"
import { startJevStub, stubChoiceBody } from "../fixtures/automation-jev-stub.js"
import {
  decodeEvalReport,
  encodeEvalReport,
  evalIssues,
  scoreClassification,
  stubChoiceForRequestBody,
  stubChoiceForText,
  stubConfidenceForChoice,
  stubProbabilitiesForChoice,
  summarizeEval
} from "../fixtures/automation-classification-eval.js"
import type { EvalItem, EvalIssue } from "../fixtures/automation-classification-eval.js"

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
const fakeKey = "stub-zen-key-for-tests-only"
const Services = Layer.mergeAll(NodeHttpClient.layerFetch, NodeServices.layer)
const offlineArtifactUrl = new URL("../fixtures/automation-classification-eval.offline.json", import.meta.url)
const liveArtifactUrl = new URL("../fixtures/automation-classification-eval.live.json", import.meta.url)

class EvalArtifactError extends Data.TaggedError("EvalArtifactError")<{
  readonly message: string
}> {}

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
  const { extension } = makeGithubExtension()
  const registry = new AutomationRegistry()
  yield* registry.register(extension)
  return registry
})

const runEvalIssue = Effect.fn("ClassificationEval.runIssue")(function*(
  configuration: Effect.Success<typeof testConfiguration>,
  registry: Effect.Success<typeof testRegistry>,
  decide: ClassificationDecide,
  issue: EvalIssue
) {
  const outcome = yield* runIssueClassification({
    configuration,
    issue: {
      issueNumber: issue.issueNumber,
      title: issue.title,
      ...(issue.body === undefined ? {} : { body: issue.body })
    },
    mode: "preview",
    decide,
    registry
  })
  if (outcome.kind === "failed") {
    const scored = scoreClassification(issue.expected, issue.accepted, { kind: "failed" })
    const item: EvalItem = {
      id: issue.id,
      source: issue.source,
      expected: issue.expected,
      predicted: scored.predicted,
      verdict: scored.verdict,
      latencyMs: outcome.latencyMs
    }
    return item
  }
  if (outcome.kind === "unresolved") {
    const scored = scoreClassification(issue.expected, issue.accepted, { kind: "unresolved" })
    const item: EvalItem = {
      id: issue.id,
      source: issue.source,
      expected: issue.expected,
      predicted: scored.predicted,
      verdict: scored.verdict,
      latencyMs: outcome.latencyMs
    }
    return item
  }
  const scored = scoreClassification(issue.expected, issue.accepted, { kind: "classified", outcomeId: outcome.outcomeId })
  const item: EvalItem = {
    id: issue.id,
    source: issue.source,
    expected: issue.expected,
    predicted: scored.predicted,
    verdict: scored.verdict,
    latencyMs: outcome.latencyMs,
    label: outcome.label
  }
  return item
})

const writeReport = Effect.fn("ClassificationEval.writeReport")(function*(
  mode: "offline-stub" | "live-jev",
  artifactUrl: URL,
  items: ReadonlyArray<EvalItem>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const totals = summarizeEval(items)
  const generatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
  const report = {
    schemaVersion: 1 as const,
    kind: "classification-eval" as const,
    mode,
    generatedAt,
    totals,
    items: [...items]
  }
  const artifactPath = yield* path.fromFileUrl(artifactUrl)
  yield* fs.writeFileString(artifactPath, encodeEvalReport(report))
  const reread = yield* fs.readFileString(artifactPath)
  const decoded = yield* Effect.try({
    try: () => decodeEvalReport(reread),
    catch: () => new EvalArtifactError({ message: "eval artifact is not re-readable" })
  })
  return { report, decoded, artifactPath }
})

const runOfflineEval = Effect.gen(function*() {
  const configuration = yield* testConfiguration
  const registry = yield* testRegistry
  const stub = yield* Effect.acquireRelease(startJevStub(), (open) => Effect.sync(() => open.close()))
  stub.setReply((call) => {
    const choice = stubChoiceForRequestBody(call.body)
    return { status: 200, body: stubChoiceBody(choice, stubProbabilitiesForChoice(choice), stubConfidenceForChoice(choice)) }
  })
  const decide: ClassificationDecide = (input) =>
    classifyJev(input.request, input.descriptions, fakeKey, { endpoint: stub.url, timeoutMs: 5000, maxRetries: 0 })
  const items: Array<EvalItem> = []
  for (const issue of evalIssues) {
    items.push(yield* runEvalIssue(configuration, registry, decide, issue))
  }
  return yield* writeReport("offline-stub", offlineArtifactUrl, items)
})

const runLiveEval = Effect.fn("ClassificationEval.runLive")(function*(apiKey: string) {
  const configuration = yield* testConfiguration
  const registry = yield* testRegistry
  const decide: ClassificationDecide = (input) => classifyJev(input.request, input.descriptions, apiKey)
  const items: Array<EvalItem> = []
  for (const issue of evalIssues) {
    items.push(yield* runEvalIssue(configuration, registry, decide, issue))
  }
  return yield* writeReport("live-jev", liveArtifactUrl, items)
})

describe("classification eval scoring", () => {
  it.live("marks selected, abstained and failed outcomes against accepted categories", () =>
    Effect.gen(function*() {
      expect(scoreClassification("bug", ["bug"], { kind: "classified", outcomeId: "bug" })).toEqual({
        predicted: "bug",
        verdict: "correct"
      })
      expect(scoreClassification("bug", ["bug"], { kind: "classified", outcomeId: "question" })).toEqual({
        predicted: "question",
        verdict: "wrong"
      })
      expect(scoreClassification("bug", ["bug", "question"], { kind: "classified", outcomeId: "question" })).toEqual({
        predicted: "question",
        verdict: "correct"
      })
      expect(scoreClassification("abstain", ["abstain"], { kind: "unresolved" })).toEqual({
        predicted: "abstain",
        verdict: "correct"
      })
      expect(scoreClassification("bug", ["bug"], { kind: "unresolved" })).toEqual({
        predicted: "abstain",
        verdict: "unresolved"
      })
      expect(scoreClassification("bug", ["bug"], { kind: "failed" })).toEqual({
        predicted: "failed",
        verdict: "unresolved"
      })
      const totals = summarizeEval([
        { id: "a", source: "s", expected: "bug", predicted: "bug", verdict: "correct", latencyMs: 3 },
        { id: "b", source: "s", expected: "bug", predicted: "question", verdict: "wrong", latencyMs: 4 },
        { id: "c", source: "s", expected: "bug", predicted: "abstain", verdict: "unresolved", latencyMs: 5 }
      ])
      expect(totals).toEqual({ issues: 3, correct: 1, wrong: 1, unresolved: 1 })
    }))
})

describe("classification eval stub", () => {
  it.live("routes representative inputs deterministically without network", () =>
    Effect.gen(function*() {
      expect(stubChoiceForText(evalIssues[0]!.title, evalIssues[0]!.body)).toBe("bug")
      expect(stubChoiceForText(evalIssues[3]!.title, evalIssues[3]!.body)).toBe("question")
      expect(stubChoiceForText(evalIssues[7]!.title, evalIssues[7]!.body)).toBe("question")
      expect(stubChoiceForText(evalIssues[8]!.title, evalIssues[8]!.body)).toBe("bug")
      expect(stubChoiceForText(evalIssues[9]!.title, evalIssues[9]!.body)).toBe("no_match")
      expect(stubChoiceForText(evalIssues[11]!.title, evalIssues[11]!.body)).toBe("no_match")
      expect(stubChoiceForText(evalIssues[12]!.title, evalIssues[12]!.body)).toBe("no_match")
    }))
})

describe("classification eval offline", () => {
  it.live("classifies every eval issue through the T08 routine with the stub transport", () =>
    Effect.gen(function*() {
      const { report, decoded } = yield* runOfflineEval
      expect(report.mode).toBe("offline-stub")
      expect(report.totals.issues).toBe(evalIssues.length)
      expect(report.totals.correct + report.totals.wrong + report.totals.unresolved).toBe(evalIssues.length)
      expect(report.items).toHaveLength(evalIssues.length)
      for (const item of report.items) {
        expect(typeof item.latencyMs).toBe("number")
        expect(item.latencyMs).toBeGreaterThanOrEqual(0)
      }
      const byId = new Map(report.items.map((item) => [item.id, item]))
      expect(byId.get("eval-01")).toMatchObject({ predicted: "bug", verdict: "correct" })
      expect(byId.get("eval-08")).toMatchObject({ predicted: "question", verdict: "wrong" })
      expect(byId.get("eval-09")).toMatchObject({ predicted: "bug", verdict: "wrong" })
      expect(byId.get("eval-10")).toMatchObject({ predicted: "abstain", verdict: "correct" })
      expect(byId.get("eval-13")).toMatchObject({ predicted: "abstain", verdict: "unresolved" })
      expect(report.totals).toEqual({ issues: 13, correct: 10, wrong: 2, unresolved: 1 })
      expect(decoded).toEqual(report)
      expect(encodeEvalReport(decoded)).not.toContain(fakeKey)
    }).pipe(Effect.provide(Services)))
})

describe("classification eval live", () => {
  it.live("records the live Jev eval once a key is available, otherwise blocked without network", () =>
    Effect.gen(function*() {
      const key = yield* resolveZenApiKey()
      if (key === null) {
        const flag = yield* Config.option(Config.String("OPENCODE_ZEN_API_KEY"))
        expect(Option.isNone(flag)).toBe(true)
        return
      }
      const { report, decoded } = yield* runLiveEval(key)
      expect(report.mode).toBe("live-jev")
      expect(report.totals.issues).toBe(evalIssues.length)
      expect(report.totals.correct + report.totals.wrong + report.totals.unresolved).toBe(evalIssues.length)
      expect(decoded).toEqual(report)
      expect(encodeEvalReport(decoded)).not.toContain(key)
    }).pipe(Effect.provide(Services)))
})
