import { Effect, Stream } from "effect"
import { Window } from "happy-dom"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { AutomationContextProvider } from "@expand/desktop/renderer/features/automations/data/automation-context"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import { AutomationStorageFailed } from "@expand/contracts/rpc/automation-schemas"
import type { RunMetrics, RunRecord, RoutineRecord } from "@expand/contracts/rpc/automation-schemas"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { useCommandPalette } from "@expand/desktop/renderer/features/command/model/command-store"

const browser = new Window({ url: "http://localhost/" })
let createAppRouter: typeof import("@expand/desktop/renderer/app/router")["createAppRouter"]
const alpha = "00000000-0000-4000-8000-000000000001"
const owner = "local"
let dom: typeof import("@testing-library/react")
let harness: typeof import("./ui-harness")

beforeAll(() => {
  vi.stubGlobal("window", browser)
  vi.stubGlobal("self", browser)
  vi.stubGlobal("document", browser.document)
  vi.stubGlobal("navigator", browser.navigator)
  vi.stubGlobal("HTMLElement", browser.HTMLElement)
  vi.stubGlobal("Element", browser.Element)
  vi.stubGlobal("Node", browser.Node)
  vi.stubGlobal("NodeFilter", browser.NodeFilter)
  vi.stubGlobal("HTMLFormElement", browser.HTMLFormElement)
  vi.stubGlobal("HTMLInputElement", browser.HTMLInputElement)
  vi.stubGlobal("MutationObserver", browser.MutationObserver)
  vi.stubGlobal("ResizeObserver", browser.ResizeObserver)
  vi.stubGlobal("Event", browser.Event)
  vi.stubGlobal("CustomEvent", browser.CustomEvent)
  vi.stubGlobal("HTMLButtonElement", browser.HTMLButtonElement)
  vi.stubGlobal("HTMLTextAreaElement", browser.HTMLTextAreaElement)
  vi.stubGlobal("getComputedStyle", browser.getComputedStyle.bind(browser))
  vi.stubGlobal("scrollTo", browser.scrollTo.bind(browser))
  vi.stubGlobal("requestAnimationFrame", browser.requestAnimationFrame.bind(browser))
  vi.stubGlobal("cancelAnimationFrame", browser.cancelAnimationFrame.bind(browser))
  return Effect.runPromise(Effect.gen(function* () {
    dom = yield* Effect.tryPromise(() => import("@testing-library/react"))
    harness = yield* Effect.tryPromise(() => import("./ui-harness"))
    createAppRouter = (yield* Effect.tryPromise(() => import("@expand/desktop/renderer/app/router"))).createAppRouter
  }))
})

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1024)
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }))
  useCommandPalette.setState({ open: false })
})

afterEach(() => {
  dom.cleanup()
  useCommandPalette.setState({ open: false })
})

afterAll(() => Effect.runPromise(Effect.gen(function* () {
  yield* Effect.tryPromise(() => dom.act(() => browser.happyDOM.abort()))
  vi.unstubAllGlobals()
})))

const mountApp = Effect.fn("AutomationOverviewTest.mountApp")(function* (path: string, rpc: AutomationRpcApi) {
  const context = harness.makeFakeProjectContext([
    harness.fakeProject({ id: alpha, name: "alpha-project" })
  ])
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter(history)
  dom.render(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <ProjectContextProvider value={context}>
        <AutomationContextProvider value={rpc}>
          <RouterProvider router={router} />
        </AutomationContextProvider>
      </ProjectContextProvider>
    </RendererRunnerProvider>
  )
  yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Overview" }))
  return { router, history }
})

describe("automation overview", () => {
  it("renders metrics, routines, and recent runs from the backend payload", () => Effect.runPromise(Effect.gen(function* () {
    const rpc = automationRpc({
      listRoutines: () => Effect.succeed({
        routines: [routineFixture("triage", "enabled"), routineFixture("labels", "paused")]
      }),
      listRuns: () => Effect.succeed({
        runs: [runFixture("run-1", { kind: "succeeded", result: "done" }, 7)],
        cursor: null
      }),
      metrics: () => Effect.succeed(metricsFixture)
    })
    yield* mountApp(`/p/${alpha}/automations`, rpc)
    yield* Effect.tryPromise(() => dom.screen.findByText("labels"))
    expect(dom.screen.getByTestId("metric-total").textContent).toBe("5")
    expect(dom.screen.getByTestId("metric-succeeded").textContent).toBe("2")
    expect(dom.screen.getByTestId("metric-failed").textContent).toBe("1")
    expect(dom.screen.getByTestId("metric-unresolved").textContent).toBe("0")
    expect(dom.screen.getByTestId("metric-queued").textContent).toBe("1")
    expect(dom.screen.getByTestId("metric-running").textContent).toBe("1")
    expect(dom.screen.getByTestId("metric-cancelled").textContent).toBe("0")
    expect(dom.screen.getByText("labels")).toBeDefined()
    expect(dom.screen.getByText("enabled")).toBeDefined()
    expect(dom.screen.getByText("paused")).toBeDefined()
    expect(dom.screen.getByText("run-1")).toBeDefined()
    expect(dom.screen.getByText("Live updates on")).toBeDefined()
    for (const routineId of ["triage", "labels"]) {
      expect(dom.screen.getByRole("link", { name: `Edit routine ${routineId}` }).getAttribute("href"))
        .toBe(`/p/${alpha}/automations/routines/${routineId}`)
      expect(dom.screen.getByRole("link", { name: `Test routine ${routineId}` }).getAttribute("href"))
        .toBe(`/p/${alpha}/automations/routines/${routineId}/test`)
    }
  })))

  it("updates the run list when a live automation event arrives", () => Effect.runPromise(Effect.gen(function* () {
    let listRunsCalls = 0
    const rpc = automationRpc({
      listRoutines: () => Effect.succeed({ routines: [routineFixture("triage", "enabled")] }),
      listRuns: () => Effect.sync(() => {
        listRunsCalls += 1
        return listRunsCalls === 1
          ? { runs: [runFixture("run-1", { kind: "running" }, 7)], cursor: null }
          : {
            runs: [
              runFixture("run-1", { kind: "running" }, 7),
              runFixture("run-2", { kind: "succeeded", result: "done" }, 8)
            ],
            cursor: null
          }
      }),
      metrics: () => Effect.succeed(metricsFixture),
      events: () => Stream.concat(Stream.make(routineChangedEvent(9, "triage")), Stream.never)
    })
    yield* mountApp(`/p/${alpha}/automations`, rpc)
    yield* Effect.tryPromise(() => dom.screen.findByText("run-2"))
    expect(listRunsCalls).toBe(2)
  })))

  it("resubscribes from the last sequence after the events stream fails", () => Effect.runPromise(Effect.gen(function* () {
    const seenFromSeq: Array<number | undefined> = []
    const rpc = automationRpc({
      listRoutines: () => Effect.succeed({ routines: [routineFixture("triage", "enabled")] }),
      listRuns: () => Effect.succeed({ runs: [], cursor: null }),
      metrics: () => Effect.succeed(emptyMetrics),
      events: (payload: { readonly fromSeq?: number }) => {
        seenFromSeq.push(payload.fromSeq)
        return seenFromSeq.length === 1
          ? Stream.concat(Stream.make(routineChangedEvent(5, "triage")), Stream.die(new Error("connection lost")))
          : Stream.never
      }
    })
    yield* mountApp(`/p/${alpha}/automations`, rpc)
    yield* Effect.tryPromise(() => dom.waitFor(() => expect(seenFromSeq.length).toBe(2), { timeout: 10000 }))
    expect(seenFromSeq).toEqual([undefined, 5])
  })))

  it("shows empty states when the backend has no routines or runs", () => Effect.runPromise(Effect.gen(function* () {
    const rpc = automationRpc({
      listRoutines: () => Effect.succeed({ routines: [] }),
      listRuns: () => Effect.succeed({ runs: [], cursor: null }),
      metrics: () => Effect.succeed(emptyMetrics)
    })
    yield* mountApp(`/p/${alpha}/automations`, rpc)
    yield* Effect.tryPromise(() => dom.screen.findByText("No routines yet. Add a routine to automate this project."))
    expect(dom.screen.getByText("No runs yet.")).toBeDefined()
    expect(dom.screen.getByTestId("metric-total").textContent).toBe("0")
  })))

  it("shows an error with retry and recovers on retry", () => Effect.runPromise(Effect.gen(function* () {
    let listRoutinesCalls = 0
    const rpc = automationRpc({
      listRoutines: () => {
        listRoutinesCalls += 1
        return listRoutinesCalls === 1
          ? Effect.fail(new AutomationStorageFailed({ code: "backend_down", message: "backend down" }))
          : Effect.succeed({ routines: [routineFixture("triage", "enabled")] })
      },
      listRuns: () => Effect.succeed({ runs: [], cursor: null }),
      metrics: () => Effect.succeed(emptyMetrics)
    })
    yield* mountApp(`/p/${alpha}/automations`, rpc)
    const alert = yield* Effect.tryPromise(() => dom.screen.findByRole("alert"))
    expect(alert.textContent).toContain("backend down")
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Retry" }))
    yield* Effect.tryPromise(() => dom.screen.findByText("triage"))
    expect(listRoutinesCalls).toBe(2)
  })))

  it("navigates to routine setup, history, and integrations from the overview", () => Effect.runPromise(Effect.gen(function* () {
    const rpc = automationRpc({
      listRoutines: () => Effect.succeed({ routines: [] }),
      listRuns: () => Effect.succeed({ runs: [], cursor: null }),
      metrics: () => Effect.succeed(emptyMetrics)
    })
    const { router } = yield* mountApp(`/p/${alpha}/automations`, rpc)
    yield* Effect.tryPromise(() => dom.screen.findByText("No runs yet."))
    dom.fireEvent.click(dom.screen.getByRole("link", { name: "Add routine" }))
    yield* Effect.tryPromise(() => dom.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/routines/new`)))
    yield* Effect.tryPromise(() => router.navigate({ to: "/p/$projectId/automations", params: { projectId: alpha } }))
    yield* Effect.tryPromise(() => dom.screen.findByText("No runs yet."))
    dom.fireEvent.click(dom.screen.getByRole("link", { name: "View history" }))
    yield* Effect.tryPromise(() => dom.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/history`)))
    yield* Effect.tryPromise(() => router.navigate({ to: "/p/$projectId/automations", params: { projectId: alpha } }))
    yield* Effect.tryPromise(() => dom.screen.findByText("No runs yet."))
    dom.fireEvent.click(dom.screen.getByRole("link", { name: "Manage integrations" }))
    yield* Effect.tryPromise(() => dom.waitFor(() =>
      expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/integrations`)))
  })))
})

const metricsFixture: RunMetrics = {
  total: 5,
  queued: 1,
  running: 1,
  succeeded: 2,
  unresolved: 0,
  failed: 1,
  cancelled: 0
}

const emptyMetrics: RunMetrics = {
  total: 0,
  queued: 0,
  running: 0,
  succeeded: 0,
  unresolved: 0,
  failed: 0,
  cancelled: 0
}

const routineFixture = (routineId: string, status: "enabled" | "paused"): RoutineRecord => ({
  routineId,
  head: { revision: 3, version: 4, status },
  configuration: { routineId } as unknown as RoutineRecord["configuration"],
  credentials: []
})

const runFixture = (id: string, state: RunRecord["run"]["state"], sequence: number): RunRecord => ({
  run: {
    schemaVersion: 1,
    kind: "run",
    id,
    scope: { ownerId: owner, projectId: alpha },
    configuration: { routineId: "triage", revision: 3 },
    input: { kind: "input-reference", id: "delivery-1" },
    mode: "live",
    authority: { routineId: "triage" } as unknown as RunRecord["run"]["authority"],
    state,
    actions: []
  },
  version: 1,
  sequence
})

const routineChangedEvent = (seq: number, routineId: string): SequencedEvent => ({
  seq,
  event: {
    _tag: "AutomationRoutineChanged",
    occurredAt: "2026-10-03T00:00:00.000Z",
    projectId: alpha,
    ownerId: owner,
    routineId,
    revision: 4,
    status: "enabled"
  } as unknown as SequencedEvent["event"]
})

const unusedAutomationEffect = (label: string) => () => Effect.die(new Error(`${label} not stubbed`))

const automationRpc = (over: Partial<AutomationRpcApi>): AutomationRpcApi => ({
  createRoutine: unusedAutomationEffect("createRoutine"),
  editRoutine: unusedAutomationEffect("editRoutine"),
  enableRoutine: unusedAutomationEffect("enableRoutine"),
  pauseRoutine: unusedAutomationEffect("pauseRoutine"),
  deleteRoutine: unusedAutomationEffect("deleteRoutine"),
  getRoutine: unusedAutomationEffect("getRoutine"),
  listRoutines: unusedAutomationEffect("listRoutines"),
  putIntegration: unusedAutomationEffect("putIntegration"),
  getIntegration: unusedAutomationEffect("getIntegration"),
  integrationStatus: unusedAutomationEffect("integrationStatus"),
  putCredential: unusedAutomationEffect("putCredential"),
  removeCredential: unusedAutomationEffect("removeCredential"),
  listCredentials: unusedAutomationEffect("listCredentials"),
  preview: unusedAutomationEffect("preview"),
  listRuns: unusedAutomationEffect("listRuns"),
  getRun: unusedAutomationEffect("getRun"),
  metrics: unusedAutomationEffect("metrics"),
  catalog: unusedAutomationEffect("catalog"),
  events: () => Stream.never,
  ...over
}) as AutomationRpcApi
