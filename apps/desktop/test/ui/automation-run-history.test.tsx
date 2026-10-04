// @vitest-environment happy-dom
import { useState } from "react"
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent, waitFor, within } from "@testing-library/react"
import { Effect, Schema } from "effect"
import { AutomationNotFound } from "@expand/contracts/rpc/automation-schemas"
import type { AutomationRun } from "@expand/contracts/automation"
import type { RoutineRecord, RunHistory, RunRecord } from "@expand/contracts/rpc/automation-schemas"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { AutomationRunContextProvider } from "@expand/desktop/renderer/features/automations/data/automation-run-context"
import { RunDetails } from "@expand/desktop/renderer/features/automations/components/RunDetails"
import { RunHistoryList } from "@expand/desktop/renderer/features/automations/components/RunHistoryList"
import { toJsonText } from "@expand/desktop/renderer/features/automations/model/run-history"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import { renderScoped } from "./ui-harness"

const projectId = "00000000-0000-4000-8000-000000000001"
const scope = { ownerId: "local", projectId }

const authority = {
  schemaVersion: 1 as const,
  kind: "invocation-authority" as const,
  scope,
  configuration: { routineId: "triage", revision: 2 },
  integrationIds: ["github"],
  actionGrants: [
    {
      action: { id: "github:label-issue" as const, version: 1 },
      integrationId: "github",
      capabilities: ["label"]
    }
  ]
}

const decisionRequest = {
  schemaVersion: 1 as const,
  kind: "jev-request" as const,
  provider: "opencode-zen" as const,
  model: "jev" as const,
  version: "1.13" as const,
  configuration: { routineId: "triage", revision: 2 },
  input: { kind: "input-reference" as const, id: "input-1" },
  outcomes: ["bug", "question"],
  data: { issueNumber: 42, title: "Login fails", body: "Steps to reproduce" }
}

const selectedDecision = {
  schemaVersion: 1 as const,
  kind: "selected" as const,
  outcomeId: "bug",
  data: { choice: "bug", probabilities: { bug: 0.9, question: 0.1 }, confidence: 0.9 }
}

const labelAction = { id: "github:label-issue" as const, version: 1 }

const makeRun = (id: string, state: AutomationRun["state"], actions: AutomationRun["actions"]): AutomationRun => ({
  schemaVersion: 1,
  kind: "run",
  id,
  scope,
  configuration: { routineId: "triage", revision: 2 },
  input: { kind: "input-reference", id: `input-${id}` },
  mode: "live",
  authority: { ...authority },
  state,
  actions,
  decision: selectedDecision
})

const makeJob = (run: AutomationRun, metadata: unknown = {}) => ({
  id: `job-${run.id}`,
  scope,
  runId: run.id,
  configuration: run.configuration,
  inputId: run.input.id,
  mode: run.mode,
  state: run.state,
  metadata: metadata as Record<string, never>
})

const makeRecord = (run: AutomationRun): RunRecord => ({ run, version: 1, sequence: 1 })

const succeededRun = makeRun("run-a", { kind: "succeeded", result: { applied: true } }, [
  {
    kind: "planned",
    stepId: "label-question",
    action: labelAction,
    arguments: { issueNumber: 42, label: "type: question" }
  },
  { kind: "succeeded", stepId: "label-bug", action: labelAction, result: { applied: true } }
])

const unresolvedRun = makeRun("run-b", { kind: "unresolved", reason: "No candidate matched the input" }, [])
const failedRun = makeRun("run-c", { kind: "failed", error: { code: "timeout", message: "Jev decision exceeded its deadline" } }, [])
const cancelledRun = makeRun("run-d", { kind: "cancelled", reason: "routine is not enabled for execution" }, [])

const allRecords = [succeededRun, unresolvedRun, failedRun, cancelledRun].map(makeRecord)

const succeededHistory: RunHistory = {
  run: { run: succeededRun, version: 2, sequence: 3 },
  job: { job: makeJob(succeededRun), version: 2, sequence: 3 },
  attempts: [
    {
      id: "decision-1",
      scope,
      runId: "run-a",
      jobId: "job-run-a",
      stepId: "decision",
      attempt: 1,
      startedAt: "1000",
      kind: "decision",
      status: "completed",
      request: { ...decisionRequest },
      finishedAt: "1250",
      result: { ...selectedDecision }
    },
    {
      id: "action-1",
      scope,
      runId: "run-a",
      jobId: "job-run-a",
      stepId: "label-bug",
      attempt: 1,
      startedAt: "1300",
      kind: "action",
      status: "completed",
      integration: { id: "github", definition: { id: "github:integration", version: 1 } },
      action: { ...labelAction },
      arguments: { issueNumber: 42, label: "type: bug" },
      finishedAt: "1400",
      outcome: { kind: "succeeded", stepId: "label-bug", action: { ...labelAction }, result: { applied: true } }
    }
  ]
}

const unresolvedHistory: RunHistory = {
  run: { run: unresolvedRun, version: 2, sequence: 2 },
  job: { job: makeJob(unresolvedRun), version: 2, sequence: 2 },
  attempts: [
    {
      id: "decision-1",
      scope,
      runId: "run-b",
      jobId: "job-run-b",
      stepId: "decision",
      attempt: 1,
      startedAt: "2000",
      kind: "decision",
      status: "completed",
      request: { ...decisionRequest, input: { kind: "input-reference", id: "input-run-b" } },
      finishedAt: "2100",
      result: { schemaVersion: 1, kind: "abstained", reason: "No candidate matched the input" }
    }
  ]
}

const routine: RoutineRecord = {
  routineId: "triage",
  head: { revision: 2, version: 3, status: "enabled" },
  configuration: {
    schemaVersion: 1,
    kind: "routine-configuration",
    reference: { routineId: "triage", revision: 2 },
    scope,
    configuration: { categories: ["bug", "question"] },
    integrations: [
      {
        schemaVersion: 1,
        kind: "integration-configuration",
        id: "github",
        definition: { id: "github:integration", version: 1 },
        configuration: { owner: "octo", repo: "hello" },
        credentials: {}
      }
    ],
    process: {
      schemaVersion: 1,
      kind: "process",
      trigger: {
        definition: { id: "github:issue-opened", version: 1 },
        integration: { id: "github", definition: { id: "github:integration", version: 1 } },
        configuration: {}
      },
      actions: {}
    }
  },
  credentials: []
}

const baseRpc: AutomationRpcApi = {
  createRoutine: () => Effect.die("unused"),
  listRoutines: () => Effect.die("unused"),
  getRoutine: () => Effect.die("unused"),
  editRoutine: () => Effect.die("unused"),
  enableRoutine: () => Effect.die("unused"),
  pauseRoutine: () => Effect.die("unused"),
  deleteRoutine: () => Effect.die("unused"),
  putCredential: () => Effect.die("unused"),
  removeCredential: () => Effect.die("unused"),
  listCredentials: () => Effect.die("unused"),
  putIntegration: () => Effect.die("unused"),
  getIntegration: () => Effect.die("unused"),
  integrationStatus: () => Effect.die("unused"),
  preview: () => Effect.die("unused"),
  listRuns: () => Effect.die("unused"),
  getRun: () => Effect.die("unused"),
  metrics: () => Effect.die("unused"),
  catalog: () => Effect.die("unused")
}

const Harness = ({ rpc }: { readonly rpc: AutomationRpcApi }) => {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  return (
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <AutomationRunContextProvider value={{ rpc }}>
        <RunHistoryList projectId={projectId} selectedRunId={selected} onSelectRun={setSelected} />
        <RunDetails projectId={projectId} runId={selected} onBack={() => setSelected(undefined)} />
      </AutomationRunContextProvider>
    </RendererRunnerProvider>
  )
}

type RunListPayload = Parameters<AutomationRpcApi["listRuns"]>[0]

const filteredRecords = (payload: RunListPayload): ReadonlyArray<RunRecord> =>
  payload.state === undefined ? allRecords : allRecords.filter((record) => record.run.state.kind === payload.state)

const encodeText = (value: unknown): string => {
  try {
    return Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value)
  } catch {
    return ""
  }
}

describe("automation run history", () => {
  it.effect("advances cursors across pages", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<RunListPayload> = []
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: (payload) => {
          seen.push(payload)
          return Effect.succeed(
            payload.cursor === undefined
              ? { runs: [allRecords[0]!], cursor: "cursor-1" }
              : { runs: [allRecords[1]!], cursor: null }
          )
        },
        getRun: () => Effect.succeed(unresolvedHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-a"))
      expect(seen.length).toBe(1)
      expect(seen[0]).toMatchObject({ limit: 10, scope })
      expect("cursor" in seen[0]!).toBe(false)
      fireEvent.click(rendered.getByRole("button", { name: "Next page" }))
      yield* Effect.tryPromise(() => rendered.findByText("run-b"))
      expect(seen.length).toBe(2)
      expect(seen[1]).toMatchObject({ cursor: "cursor-1", limit: 10, scope })
      fireEvent.click(rendered.getByRole("button", { name: "Previous page" }))
      yield* Effect.tryPromise(() => rendered.findByText("Page 1"))
      expect(rendered.getByText("run-a")).toBeDefined()
      expect(seen.length).toBe(2)
    })))

  it.effect("narrows results through outcome filters", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<RunListPayload> = []
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: (payload) => {
          seen.push(payload)
          return Effect.succeed({ runs: filteredRecords(payload), cursor: null })
        },
        getRun: () => Effect.succeed(unresolvedHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-d"))
      fireEvent.click(rendered.getByRole("button", { name: "Unresolved" }))
      yield* Effect.tryPromise(() =>
        waitFor(() => {
          expect(rendered.queryByText("run-a")).toBeNull()
          expect(rendered.getByText("run-b")).toBeDefined()
        })
      )
      expect(seen[seen.length - 1]).toMatchObject({ state: "unresolved" })
      fireEvent.click(rendered.getByRole("button", { name: "Completed" }))
      yield* Effect.tryPromise(() =>
        waitFor(() => {
          expect(rendered.getByText("run-a")).toBeDefined()
          expect(rendered.queryByText("run-b")).toBeNull()
        })
      )
      expect(seen[seen.length - 1]).toMatchObject({ state: "succeeded" })
    })))

  it.effect("maps failed and cancelled filters to server states", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<RunListPayload> = []
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: (payload) => {
          seen.push(payload)
          return Effect.succeed({ runs: filteredRecords(payload), cursor: null })
        },
        getRun: () => Effect.succeed(unresolvedHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-d"))
      fireEvent.click(rendered.getByRole("button", { name: "Failed" }))
      yield* Effect.tryPromise(() =>
        waitFor(() => {
          expect(rendered.getByText("run-c")).toBeDefined()
          expect(rendered.queryByText("run-a")).toBeNull()
        })
      )
      expect(seen[seen.length - 1]).toMatchObject({ state: "failed" })
      fireEvent.click(rendered.getByRole("button", { name: "Cancelled" }))
      yield* Effect.tryPromise(() =>
        waitFor(() => {
          expect(rendered.getByText("run-d")).toBeDefined()
          expect(rendered.queryByText("run-c")).toBeNull()
        })
      )
      expect(seen[seen.length - 1]).toMatchObject({ state: "cancelled" })
    })))

  it.effect("shows the filter-empty state", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.succeed({ runs: [], cursor: null })
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("No runs yet."))
      fireEvent.click(rendered.getByRole("button", { name: "Failed" }))
      yield* Effect.tryPromise(() => rendered.findByText("No runs match the current filter."))
    })))

  it.effect("shows the search-empty state", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.succeed({ runs: allRecords, cursor: null }),
        getRun: () => Effect.succeed(unresolvedHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-d"))
      fireEvent.change(rendered.getByLabelText("Search runs"), { target: { value: "zzz-no-such-run" } })
      yield* Effect.tryPromise(() => rendered.findByText("No runs match the current search."))
    })))

  it.effect("narrows the visible runs through text search", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.succeed({ runs: allRecords, cursor: null }),
        getRun: () => Effect.succeed(unresolvedHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-d"))
      fireEvent.change(rendered.getByLabelText("Search runs"), { target: { value: "run-b" } })
      yield* Effect.tryPromise(() =>
        waitFor(() => {
          expect(rendered.queryByText("run-a")).toBeNull()
          expect(rendered.getByText("run-b")).toBeDefined()
        })
      )
    })))

  it.effect("shows provider evidence with planned and applied actions", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.succeed({ runs: [allRecords[0]!], cursor: null }),
        getRun: () => Effect.succeed(succeededHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-a"))
      fireEvent.click(rendered.getByText("run-a"))
      yield* Effect.tryPromise(() => rendered.findByText("Provider evidence"))
      expect(rendered.getByText("Original input")).toBeDefined()
      expect(rendered.getByText("Routine revision")).toBeDefined()
      expect(rendered.getByText("Exact configuration at run time: routine triage revision 2")).toBeDefined()
      expect(rendered.getByText("opencode-zen jev 1.13")).toBeDefined()
      expect(rendered.getByText("choice: bug")).toBeDefined()
      expect(rendered.getByText("confidence: 0.9")).toBeDefined()
      expect(rendered.getByText("Latency: 250 ms")).toBeDefined()
      expect(rendered.getByText("PLANNED")).toBeDefined()
      expect(rendered.getByText("APPLIED")).toBeDefined()
      expect(rendered.getByText("Action timeline")).toBeDefined()
      expect(rendered.getByText("Results and errors")).toBeDefined()
      const github = rendered.getByRole("link", { name: "Open GitHub issue #42" })
      expect(github.getAttribute("href")).toBe("https://github.com/octo/hello/issues/42")
      const retest = rendered.getByRole("link", { name: "Re-test with updated rules" })
      expect(retest.getAttribute("href")).toContain("triage")
      expect(retest.getAttribute("href")).toContain("test")
    })))

  it.effect("keeps unresolved runs visible with the nothing-changed state", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.succeed({ runs: allRecords, cursor: null }),
        getRun: () => Effect.succeed(unresolvedHistory),
        getRoutine: () => Effect.succeed(routine)
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-b"))
      const list = rendered.getByRole("list", { name: "Automation runs" })
      expect(within(list).getByText("Unresolved")).toBeDefined()
      fireEvent.click(within(list).getByText("run-b"))
      yield* Effect.tryPromise(() => rendered.findByText("Run: Nothing changed: No candidate matched the input"))
    })))

  it.effect("shows the empty state", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.succeed({ runs: [], cursor: null })
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("No runs yet."))
    })))

  it.effect("shows the error state", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listRuns: () => Effect.fail(new AutomationNotFound({ code: "missing", message: "Run does not exist" }))
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByRole("alert"))
      expect(rendered.getByRole("alert").textContent).toContain("Run does not exist")
    })))

  it.effect("carries no secrets and never calls credential endpoints", () =>
    Effect.scoped(Effect.gen(function* () {
      const canary = "super-secret-canary-41"
      const credentialSpy = vi.fn(() => Effect.die("unused"))
      const rpc: AutomationRpcApi = {
        ...baseRpc,
        listCredentials: credentialSpy,
        putCredential: credentialSpy,
        removeCredential: credentialSpy,
        listRuns: () => Effect.succeed({ runs: [allRecords[0]!], cursor: null }),
        getRun: () =>
          Effect.succeed({
            ...succeededHistory,
            job: { ...succeededHistory.job, job: makeJob(succeededRun, { note: canary }) },
            attempts: succeededHistory.attempts.map((attempt) =>
              typeof attempt === "object" && attempt !== null && "request" in attempt
                ? {
                  ...attempt,
                  request: {
                    ...(attempt.request as Record<string, unknown>),
                    data: { ...decisionRequest.data, apiToken: canary }
                  }
                }
                : attempt
            )
          }),
        getRoutine: () =>
          Effect.succeed({
            ...routine,
            configuration: { ...routine.configuration, configuration: { categories: ["bug"], note: canary } }
          })
      }
      const rendered = yield* renderScoped(<Harness rpc={rpc} />)
      yield* Effect.tryPromise(() => rendered.findByText("run-a"))
      fireEvent.click(rendered.getByText("run-a"))
      yield* Effect.tryPromise(() => rendered.findByText("Provider evidence"))
      const text = document.body.textContent ?? ""
      expect(text).not.toContain(canary)
      expect(text).not.toContain("super-secret")
      expect(toJsonText({ apiToken: canary })).toContain("[redacted]")
      expect(toJsonText({ apiToken: canary })).not.toContain(canary)
      expect(document.body.textContent ?? "").toContain("[redacted]")
      expect(credentialSpy).not.toHaveBeenCalled()
    })))
})
