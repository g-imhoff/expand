import { Schema } from "effect"

export interface ScoredOutcome {
  readonly kind: "classified" | "unresolved" | "failed"
  readonly outcomeId?: string
}

export {
  type EvalIssue,
  type EvalItem,
  encodeEvalReport,
  decodeEvalReport,
  evalIssues,
  scoreClassification,
  summarizeEval,
  stubChoiceForText,
  stubChoiceForRequestBody,
  stubProbabilitiesForChoice,
  stubConfidenceForChoice
}





const EvalExpected = Schema.Literals(["bug", "question", "abstain"])
type EvalExpected = typeof EvalExpected.Type

const EvalIssue = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  source: Schema.String.check(Schema.isMinLength(1)),
  issueNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMinLength(1)),
  body: Schema.optional(Schema.String),
  expected: EvalExpected,
  accepted: Schema.Array(Schema.Literals(["bug", "question", "abstain"]))
})
type EvalIssue = typeof EvalIssue.Type

const EvalVerdict = Schema.Literals(["correct", "wrong", "unresolved"])
type EvalVerdict = typeof EvalVerdict.Type

const EvalItem = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  source: Schema.String.check(Schema.isMinLength(1)),
  expected: EvalExpected,
  predicted: Schema.Literals(["bug", "question", "abstain", "failed"]),
  verdict: EvalVerdict,
  latencyMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  label: Schema.optional(Schema.String)
})
type EvalItem = typeof EvalItem.Type

const EvalTotals = Schema.Struct({
  issues: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  correct: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  wrong: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unresolved: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
type EvalTotals = typeof EvalTotals.Type

const EvalReport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("classification-eval"),
  mode: Schema.Literals(["offline-stub", "live-jev"]),
  generatedAt: Schema.String.check(Schema.isMinLength(1)),
  totals: EvalTotals,
  items: Schema.Array(EvalItem)
})
type EvalReport = typeof EvalReport.Type

const EvalReportFromJson = Schema.fromJsonString(EvalReport)

const encodeEvalReport = Schema.encodeSync(EvalReportFromJson)

const decodeEvalReport = Schema.decodeUnknownSync(EvalReportFromJson)

const evalIssues: Array<EvalIssue> = [
  {
    id: "eval-01",
    source: "g-imhoff/expand#10",
    issueNumber: 101,
    title: "Bound desktop MessagePort RPC ingress to prevent memory exhaustion",
    body: "The production desktop RPC transports buffer every inbound MessagePort frame in an Effect queue with infinite default capacity. Failure mode: a sender can post frames faster than the decoder consumes them, so memory can grow until the renderer or Electron main process is terminated.",
    expected: "bug",
    accepted: ["bug"]
  },
  {
    id: "eval-02",
    source: "g-imhoff/expand#14",
    issueNumber: 102,
    title: "Do not spawn a backend when endpoint discovery fails with a filesystem error",
    body: "Failure scenario: the endpoint file becomes unreadable with an I/O error, discovery converts the filesystem failure into absence, and findOrSpawnBackend starts a competing backend process instead of surfacing the original error.",
    expected: "bug",
    accepted: ["bug"]
  },
  {
    id: "eval-03",
    source: "g-imhoff/expand#11",
    issueNumber: 103,
    title: "Recreate the desktop window when a running macOS app is activated",
    body: "Actual behavior: the process remains alive with no windows, and activation does not create a new window. Expected behavior: activating a running application with no open windows creates a fully initialized replacement window.",
    expected: "bug",
    accepted: ["bug"]
  },
  {
    id: "eval-04",
    source: "synthetic",
    issueNumber: 104,
    title: "How do I run the backend with --keep-running?",
    body: "How do I keep the backend listening with zero clients connected? What is the right flag so background automations continue while nobody has Expand open?",
    expected: "question",
    accepted: ["question"]
  },
  {
    id: "eval-05",
    source: "synthetic",
    issueNumber: 105,
    title: "How do I switch projects in the sidebar?",
    body: "Where is the current project shown? How do I switch between projects and keep the conversation pane visible?",
    expected: "question",
    accepted: ["question"]
  },
  {
    id: "eval-06",
    source: "synthetic",
    issueNumber: 106,
    title: "App crashes on startup, bug or misconfiguration?",
    body: "The backend exits immediately on launch. Am I misconfiguring the state root, or is this a defect? How should recovery work here?",
    expected: "bug",
    accepted: ["bug", "question"]
  },
  {
    id: "eval-07",
    source: "g-imhoff/expand#13",
    issueNumber: 107,
    title: "Recover stale backend locks when an owner PID has been reused",
    body: "Failure scenario: a backend exits uncleanly, the operating system later assigns its PID to an unrelated process, and the stale owner is treated as the live backend so the lock is never reclaimed. How should recovery work?",
    expected: "bug",
    accepted: ["bug", "question"]
  },
  {
    id: "eval-08",
    source: "synthetic",
    issueNumber: 108,
    title: "Question: sidebar crashes on open?",
    body: "The sidebar crashes when I open it with a large inbox. Is this a renderer defect I should report, or is there a setting I am missing?",
    expected: "bug",
    accepted: ["bug"]
  },
  {
    id: "eval-09",
    source: "synthetic",
    issueNumber: 109,
    title: "Bug: queue bound docs wrong?",
    body: "The docs say the bound is 100 but the code uses 64. What is the right value? Not a crash report, just asking for the correct number.",
    expected: "question",
    accepted: ["question"]
  },
  {
    id: "eval-10",
    source: "g-imhoff/expand#21",
    issueNumber: 110,
    title: "Desktop sidebar: device / project / worktree navigation based on shadcn sidebar-09",
    body: "Goal: add a complete sidebar to the Expand desktop app, reusing the shadcn sidebar-09 block. No device concepts exist in the codebase yet; the sidebar-09 source must be vendored in by the coordinator.",
    expected: "abstain",
    accepted: ["abstain"]
  },
  {
    id: "eval-11",
    source: "g-imhoff/expand#48",
    issueNumber: 111,
    title: "Automation T22: Add Sentry issue classification",
    body: "Deferred from the current delivery at the human's request. Keep this issue open for later; Gmail is the current integration focus.",
    expected: "abstain",
    accepted: ["abstain"]
  },
  {
    id: "eval-12",
    source: "synthetic",
    issueNumber: 112,
    title: "What is today's stock price?",
    body: "What did the entrepreneur course say about sales framing? Neither a defect report nor a usage question about Expand.",
    expected: "abstain",
    accepted: ["abstain"]
  },
  {
    id: "eval-13",
    source: "synthetic",
    issueNumber: 113,
    title: "Backend exits when clients disconnect",
    body: "It stops.",
    expected: "bug",
    accepted: ["bug"]
  }
]

const scoreClassification = (
  expected: EvalExpected,
  accepted: ReadonlyArray<EvalExpected>,
  outcome: ScoredOutcome
): { readonly predicted: EvalItem["predicted"]; readonly verdict: EvalVerdict } => {
  if (outcome.kind === "failed") return { predicted: "failed", verdict: "unresolved" }
  if (outcome.kind === "unresolved") {
    return expected === "abstain"
      ? { predicted: "abstain", verdict: "correct" }
      : { predicted: "abstain", verdict: "unresolved" }
  }
  const predicted = outcome.outcomeId === "bug" || outcome.outcomeId === "question" ? outcome.outcomeId : "abstain"
  if (predicted === "abstain") return { predicted, verdict: "unresolved" }
  return accepted.includes(predicted)
    ? { predicted, verdict: "correct" }
    : { predicted, verdict: "wrong" }
}

const summarizeEval = (items: ReadonlyArray<EvalItem>): EvalTotals => {
  let correct = 0
  let wrong = 0
  let unresolved = 0
  for (const item of items) {
    if (item.verdict === "correct") correct += 1
    else if (item.verdict === "wrong") wrong += 1
    else unresolved += 1
  }
  return { issues: items.length, correct, wrong, unresolved }
}

const stubChoiceForText = (title: string, body?: string): "bug" | "question" | "no_match" => {
  const text = body === undefined || body.length === 0 ? title : `${title}\n${body}`
  if (OutOfScopePattern.test(text)) return "no_match"
  if (QuestionPattern.test(text)) return "question"
  if (BugPattern.test(text)) return "bug"
  if (text.includes("?")) return "question"
  return "no_match"
}

const stubChoiceForState = (state: unknown): "bug" | "question" | "no_match" => {
  if (typeof state !== "object" || state === null) return "no_match"
  const record = state as Record<string, unknown>
  const title = typeof record["title"] === "string" ? record["title"] : ""
  const body = typeof record["body"] === "string" ? record["body"] : undefined
  return stubChoiceForText(title, body)
}

const stubChoiceForRequestBody = (body: unknown): "bug" | "question" | "no_match" => {
  if (typeof body !== "object" || body === null) return "no_match"
  return stubChoiceForState((body as Record<string, unknown>)["state"])
}

const stubProbabilitiesForChoice = (choice: "bug" | "question" | "no_match"): Record<string, number> =>
  choice === "bug"
    ? { bug: 0.82, question: 0.12, no_match: 0.06 }
    : choice === "question"
      ? { bug: 0.12, question: 0.82, no_match: 0.06 }
      : { bug: 0.2, question: 0.2, no_match: 0.6 }

const stubConfidenceForChoice = (choice: "bug" | "question" | "no_match"): number =>
  choice === "no_match" ? 0.35 : 0.78

const OutOfScopePattern = /reusing the shadcn|must be vendored|draft pr against|deferred from the current delivery|stock price|sales framing/i
const QuestionPattern = /how do i|how to|how do you|how can i|how should|where is|question:/i
const BugPattern = /crash|memory|reproduc|failure|does not|fails|denial of service|stack trace|oom|broken|bug:/i
