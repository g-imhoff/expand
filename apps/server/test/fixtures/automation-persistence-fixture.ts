import type { AutomationRun, RoutineConfiguration } from "@expand/contracts/automation"
import { sampleConfiguration, sampleAuthority } from "./automation-sample-extension.js"
import type { Delivery } from "../../automation/persistence-models.js"

export const configuration: RoutineConfiguration = {
  ...sampleConfiguration, reference: { routineId: "routine", revision: 1 },
  process: { ...sampleConfiguration.process, decision: { kind: "jev", provider: "opencode-zen", model: "jev", version: "1.13", outcomes: ["selected"] }, actions: { selected: sampleConfiguration.process.actions["triggered"]! } }
}
export const scope = configuration.scope
export const integration = configuration.integrations[0]!
export const raw = new Uint8Array([0, 255, 10, 195, 169, 0, 123, 125])
export const delivery: Delivery = { schemaVersion: 1, id: "input", scope, integration: { id: integration.id, definition: integration.definition }, externalId: "external-1", trigger: configuration.process.trigger.definition, payload: { subject: "é", count: "2", nested: [null, true, { value: 42 }] } }
export const run: AutomationRun = {
  schemaVersion: 1, kind: "run", id: "run", scope, configuration: configuration.reference, input: { kind: "input-reference", id: delivery.id }, mode: "live",
  authority: { ...sampleAuthority, configuration: configuration.reference }, state: { kind: "queued" }, actions: []
}

export const failure = { code: "fixture-failed", message: "Supplied failure", details: { attempt: 1 } }
export const decisionRequest = { schemaVersion: 1, kind: "jev-request", provider: "opencode-zen", model: "jev", version: "1.13", configuration: configuration.reference, input: run.input, outcomes: ["selected"], data: delivery.payload } as const
export const decisionResult = { schemaVersion: 1, kind: "selected", outcomeId: "selected", data: { supplied: true } } as const
export const action = configuration.process.actions["selected"]![0]!
export const actionResult = { kind: "succeeded", stepId: action.id, action: action.action, result: { total: 2, supplied: "actual fixture" } } as const
export const baseJob = { id: "job", scope, runId: run.id, configuration: configuration.reference, inputId: delivery.id, mode: run.mode, state: run.state, metadata: {} }
export const finalRun: AutomationRun = { ...run, state: { kind: "running" }, decision: decisionResult, actions: [actionResult] }
export const finalJob = { ...baseJob, state: finalRun.state, metadata: { lease: "caller-supplied", scheduledAt: "2026-10-03T00:00:00Z" } }
export const attemptValues: ReadonlyArray<import("../../automation/persistence-models.js").Attempt> = [
  { id: "job-1", scope, runId: run.id, jobId: "job", stepId: "job", attempt: 1, startedAt: "t1", kind: "job", status: "completed", request: { reason: "supplied" }, completion: { finishedAt: "t2", error: failure } },
  { id: "job-2", scope, runId: run.id, jobId: "job", stepId: "job", attempt: 2, startedAt: "t3", kind: "job", status: "completed", request: { reason: "retry" }, completion: { finishedAt: "t4", result: { accepted: true } } },
  { id: "decision-1", scope, runId: run.id, jobId: "job", stepId: "decision", attempt: 1, startedAt: "t1", kind: "decision", status: "completed", request: decisionRequest, finishedAt: "t2", error: failure },
  { id: "decision-2", scope, runId: run.id, jobId: "job", stepId: "decision", attempt: 2, startedAt: "t3", kind: "decision", status: "completed", request: decisionRequest, finishedAt: "t4", result: decisionResult },
  { id: "action-1", scope, runId: run.id, jobId: "job", stepId: action.id, attempt: 1, startedAt: "t1", kind: "action", status: "completed", integration: action.integration, action: action.action, arguments: { message: "é", count: "2" }, finishedAt: "t2", outcome: { kind: "failed", stepId: action.id, action: action.action, error: failure } },
  { id: "action-2", scope, runId: run.id, jobId: "job", stepId: action.id, attempt: 2, startedAt: "t3", kind: "action", status: "completed", integration: action.integration, action: action.action, arguments: { message: "é", count: "2" }, finishedAt: "t4", outcome: actionResult },
  { id: "action-3", scope, runId: run.id, jobId: "job", stepId: action.id, attempt: 3, startedAt: "t5", kind: "action", status: "started", integration: action.integration, action: action.action, arguments: { message: "unfinished", count: "2" } }
]
export const startOf = (value: import("../../automation/persistence-models.js").Attempt): import("../../automation/persistence-models.js").Attempt => {
  const { completion: _completion, result: _result, error: _error, finishedAt: _finishedAt, outcome: _outcome, ...start } = value as import("../../automation/persistence-models.js").Attempt & { completion?: unknown; result?: unknown; error?: unknown; finishedAt?: unknown; outcome?: unknown }
  return { ...start, status: "started" } as import("../../automation/persistence-models.js").Attempt
}
