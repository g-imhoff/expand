import { Effect } from "effect"
import { Window } from "happy-dom"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { useCommandPalette } from "@expand/desktop/renderer/features/command/model/command-store"

const browser = new Window({ url: "http://localhost/" })
let createAppRouter: typeof import("@expand/desktop/renderer/app/router")["createAppRouter"]
const alpha = "00000000-0000-4000-8000-000000000001"
const beta = "00000000-0000-4000-8000-000000000002"
const encodedProject = "00000000-0000-4000-8000-000000000003"
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

const sections = [
  ["", "Overview"],
  ["/integrations", "Integrations"],
  ["/routines/new", "Routine setup"],
  ["/history", "History"]
] as const

const mountApp = Effect.fn("AutomationTest.mountApp")(function* (path: string, archived = false) {
  const context = harness.makeFakeProjectContext([
    harness.fakeProject({ id: alpha, name: "alpha-project", archived }),
    harness.fakeProject({ id: beta, name: "beta-project" }),
    harness.fakeProject({ id: encodedProject, name: "encoded-project" })
  ])
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter(history)
  dom.render(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <ProjectContextProvider value={context}>
        <RouterProvider router={router} />
      </ProjectContextProvider>
    </RendererRunnerProvider>
  )
  yield* Effect.tryPromise(() => dom.screen.findByRole("button", { name: "Open sidebar" }))
  return { router, history, context }
})

const expectPath = Effect.fn("AutomationTest.expectPath")(function* (router: ReturnType<typeof createAppRouter>, path: string) {
  yield* Effect.tryPromise(() => dom.waitFor(() => expect(router.state.location.pathname).toBe(path)))
})

const selectProject = (name: string) => {
  const trigger = dom.screen.getByRole("button", { name: /Active project:/ })
  dom.fireEvent.pointerDown(trigger)
  dom.fireEvent.click(trigger)
  dom.fireEvent.click(dom.screen.getByRole("menuitem", { name: new RegExp(name) }))
}

const selectConversation = () => {
  dom.fireEvent.click(dom.screen.getByRole("button", { name: "Sidebar three-zone shape, unread" }))
}

describe("production automation routes", () => {
  it.each(sections)("opens the direct automation URL %s", (suffix, label) => Effect.runPromise(Effect.gen(function* () {
    yield* mountApp(`/p/${alpha}/automations${suffix}`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: label }))
    expect(dom.screen.getByText("alpha-project", { selector: "p" })).toBeDefined()
    expect(dom.screen.getByRole("button", { name: "Automations" }).getAttribute("aria-current")).toBe("page")
    const navigation = dom.screen.getByRole("navigation", { name: "Automation pages" })
    expect(dom.within(navigation).getByRole("button", { name: label }).getAttribute("aria-current")).toBe("page")
    expect(dom.screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe(`/p/${alpha}`)
  })))

  it("opens overview from the rail and navigates all sections, workspace, back and forward", () => Effect.runPromise(Effect.gen(function* () {
    const { router, history } = yield* mountApp(`/p/${alpha}`)
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Automations" }))
    yield* expectPath(router, `/p/${alpha}/automations`)
    for (const [suffix, label] of sections) {
      dom.fireEvent.click(yield* Effect.tryPromise(() => dom.screen.findByRole("button", { name: label })))
      yield* expectPath(router, `/p/${alpha}/automations${suffix}`)
      yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: label }))
    }
    dom.fireEvent.click(dom.screen.getByRole("link", { name: "Back to workspace" }))
    yield* expectPath(router, `/p/${alpha}`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "alpha-project" }))
    history.back()
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "History" }))
    history.forward()
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "alpha-project" }))
  })))

  it.each(sections)("preserves section %s on project selection and clears preview", (suffix, label) => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${alpha}/automations${suffix}`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: label }))
    selectConversation()
    selectProject("beta-project")
    yield* expectPath(router, `/p/${beta}/automations${suffix}`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: label }))
    expect(dom.screen.getByText("beta-project", { selector: "p" })).toBeDefined()
    expect(dom.screen.queryByText("Sample conversation preview")).toBeNull()
  })))

  it("keeps the full conversation article and returns to the prior automation section", () => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${alpha}/automations/history`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "History" }))
    selectConversation()
    const article = dom.screen.getByRole("article")
    expect(dom.within(article).getByRole("heading", { name: "Sidebar three-zone shape" })).toBeDefined()
    expect(dom.within(article).getByText("Rail holds devices, the panel holds the project switcher and the worktree inbox.")).toBeDefined()
    expect(dom.screen.queryByRole("navigation", { name: "Automation pages" })).toBeNull()
    expect(dom.screen.getByRole("button", { name: "Automations" }).getAttribute("aria-current")).toBeNull()
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Back to automations" }))
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "History" }))
    expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/history`)
  })))

  it("clears preview when the rail reopens overview at the same URL", () => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${alpha}/automations`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Overview" }))
    selectConversation()
    dom.fireEvent.click(dom.screen.getByRole("button", { name: "Automations" }))
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Overview" }))
    expect(dom.screen.queryByText("Sample conversation preview")).toBeNull()
    expect(router.state.location.pathname).toBe(`/p/${alpha}/automations`)
  })))

  it("keeps the route and clears preview on device switch", () => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${alpha}/automations/integrations`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Integrations" }))
    selectConversation()
    const device = dom.screen.getByRole("button", { name: "Switch sample device, active: This machine" })
    dom.fireEvent.pointerDown(device)
    dom.fireEvent.click(device)
    dom.fireEvent.click(dom.screen.getByRole("menuitem", { name: /Field laptop/ }))
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Integrations" }))
    expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/integrations`)
    expect(dom.screen.getByRole("button", { name: "Switch sample device, active: Field laptop" })).toBeDefined()
  })))

  it("keeps command palette project opening directed to workspace", () => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${alpha}/automations/history`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "History" }))
    selectConversation()
    useCommandPalette.setState({ open: true })
    const dialog = yield* Effect.tryPromise(() => dom.screen.findByRole("dialog", { name: "Command Palette" }))
    dom.fireEvent.click(dom.within(dialog).getByText("alpha-project", { exact: true }))
    yield* expectPath(router, `/p/${alpha}`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "alpha-project" }))
    expect(dom.screen.queryByText("Sample conversation preview")).toBeNull()
  })))

  it("decodes encoded project IDs and names archived projects", () => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${encodedProject.replace(/^0/, "%30")}/automations/history`, true)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "History" }))
    expect(dom.screen.getByRole("button", { name: "Active project: encoded-project" })).toBeDefined()
    yield* Effect.tryPromise(() => router.navigate({ to: "/p/$projectId/automations", params: { projectId: alpha } }))
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Overview" }))
    expect(dom.screen.getByRole("button", { name: "Active project: alpha-project" })).toBeDefined()
  })))

  it("shows unknown and deleted projects without enabled automation navigation", () => Effect.runPromise(Effect.gen(function* () {
    const { router, context } = yield* mountApp("/p/missing/automations/history")
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Unknown project" }))
    expect(dom.screen.getByRole("link", { name: "Projects" })).toBeDefined()
    expect(dom.screen.queryByRole("navigation", { name: "Automation pages" })).toBeNull()
    const rail = dom.screen.getByRole("button", { name: "Automations" })
    expect(rail.getAttribute("aria-disabled")).toBe("true")
    expect(rail.getAttribute("aria-current")).toBeNull()
    dom.fireEvent.click(rail)
    expect(router.state.location.pathname).toBe("/p/missing/automations/history")
    yield* Effect.tryPromise(() => router.navigate({ to: "/p/$projectId/automations", params: { projectId: alpha } }))
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Overview" }))
    context.store.setState({ projects: [], seq: 1 })
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "Unknown project" }))
    expect(dom.screen.queryByRole("navigation", { name: "Automation pages" })).toBeNull()
    expect(rail.getAttribute("aria-disabled")).toBe("true")
    expect(rail.getAttribute("aria-current")).toBeNull()
  })))

  it("keeps the no-project control focusable with an explanation and no route mutation", () => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp("/")
    const button = dom.screen.getByRole("button", { name: "Automations" })
    button.focus()
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute("aria-disabled")).toBe("true")
    expect((yield* Effect.tryPromise(() => dom.screen.findByRole("tooltip"))).textContent).toBe("Select a project to open automations")
    dom.fireEvent.click(button)
    expect(router.state.location.pathname).toBe("/")
  })))

  it.each([`/p/${alpha}/automations-other`, `/p/${alpha}/automations/history-extra`])("does not mark unrelated path %s active", (path) => Effect.runPromise(Effect.gen(function* () {
    const { router } = yield* mountApp(`/p/${alpha}/automations/history`)
    yield* Effect.tryPromise(() => dom.screen.findByRole("heading", { name: "History" }))
    const rail = dom.screen.getByRole("button", { name: "Automations" })
    expect(rail.getAttribute("aria-current")).toBe("page")
    router.history.push(path)
    yield* Effect.tryPromise(() => dom.waitFor(() => expect(rail.getAttribute("aria-current")).toBeNull()))
  })))
})
