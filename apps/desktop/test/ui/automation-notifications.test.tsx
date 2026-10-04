import { Window } from "happy-dom"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"

const browser = new Window({ url: "http://localhost/" })
let dom: typeof import("@testing-library/react")
let notifications: typeof import("@expand/desktop/renderer/features/automations/components/AutomationNotifications")
let model: typeof import("@expand/desktop/renderer/features/automations/model/automation-notifications")

beforeAll(() => {
  vi.stubGlobal("window", browser)
  vi.stubGlobal("self", browser)
  vi.stubGlobal("document", browser.document)
  vi.stubGlobal("navigator", browser.navigator)
  vi.stubGlobal("HTMLElement", browser.HTMLElement)
  vi.stubGlobal("Element", browser.Element)
  vi.stubGlobal("Node", browser.Node)
  return Effect.runPromise(Effect.gen(function* () {
    dom = yield* Effect.tryPromise(() => import("@testing-library/react"))
    notifications = yield* Effect.tryPromise(() => import("@expand/desktop/renderer/features/automations/components/AutomationNotifications"))
    model = yield* Effect.tryPromise(() => import("@expand/desktop/renderer/features/automations/model/automation-notifications"))
  }))
})

afterEach(() => {
  dom.cleanup()
})

afterAll(() => Effect.runPromise(Effect.gen(function* () {
  yield* Effect.tryPromise(() => dom.act(() => browser.happyDOM.abort()))
  vi.unstubAllGlobals()
})))

const renderWithRouter = (node: React.ReactNode) => {
  const rootRoute = createRootRoute({ component: () => <>{node}</> })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{node}</> })
  const routeTree = rootRoute.addChildren([indexRoute])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) })
  dom.render(<RouterProvider router={router} />)
  return router
}

describe("automation notifications", () => {
  it("labels failure and unresolved distinctly with history links and explicit read", () => Effect.runPromise(Effect.gen(function* () {
    expect(model.notificationKindLabel("failure")).toBe("Failed")
    expect(model.notificationKindLabel("unresolved")).toBe("Needs input")
    expect(model.notificationHistoryPath("alpha")).toBe("/p/alpha/automations/history")
    const marked: Array<string> = []
    renderWithRouter(
      <notifications.AutomationNotifications
        projectId="alpha"
        notifications={[
          { runId: "run-bad", routineId: "triage", kind: "failure", title: "Automation triage failed", message: "busy" },
          { runId: "run-open", routineId: "triage", kind: "unresolved", title: "Automation triage needs input", message: "no match" }
        ]}
        onMarkRead={(runId) => {
          marked.push(runId)
        }}
      />
    )
    yield* Effect.tryPromise(() => dom.screen.findByText(/Failed: Automation triage failed/))
    expect(dom.screen.getByText(/Needs input: Automation triage needs input/)).toBeDefined()
    expect(dom.screen.getByRole("link", { name: "View run run-bad" }).getAttribute("href")).toBe("/p/alpha/automations/history")
    yield* Effect.sync(() => dom.fireEvent.click(dom.screen.getAllByRole("button", { name: "Mark read" })[0]!))
    expect(marked).toEqual(["run-bad"])
  })))
  it("shows an empty state without marking anything read", () => Effect.runPromise(Effect.gen(function* () {
    let calls = 0
    renderWithRouter(
      <notifications.AutomationNotifications projectId="alpha" notifications={[]} onMarkRead={() => {
        calls += 1
      }} />
    )
    yield* Effect.tryPromise(() => dom.screen.findByText("No pending notifications."))
    expect(calls).toBe(0)
  })))
})
