// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { createAppRouter } from "@expand/desktop/renderer/app/router"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { useCommandPalette } from "@expand/desktop/renderer/features/command/model/command-store"
import { fakeProject, makeFakeProjectContext, renderWithProjectContextScoped, uid } from "./ui-harness"

const runner: RendererRunner = { start: startRendererRoot }
const alpha = uid(1)
const beta = uid(2)
const encodedProject = uid(3)

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
  useCommandPalette.setState({ open: false })
  vi.unstubAllGlobals()
})

const sections = [
  ["", "Overview"],
  ["/integrations", "Integrations"],
  ["/routines/new", "Routine setup"],
  ["/history", "History"]
] as const

const mountApp = Effect.fn("AutomationTest.mountApp")(function* (path: string, archived = false) {
  const context = makeFakeProjectContext([
    fakeProject({ id: alpha, name: "alpha-project", archived }),
    fakeProject({ id: beta, name: "beta-project" }),
    fakeProject({ id: encodedProject, name: "encoded-project" })
  ])
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter(history)
  yield* renderWithProjectContextScoped(
    <RendererRunnerProvider value={runner}>
      <RouterProvider router={router} />
    </RendererRunnerProvider>,
    context
  )
  yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Open sidebar" }))
  return { router, history, context }
})

const expectPath = Effect.fn("AutomationTest.expectPath")(function* (router: ReturnType<typeof createAppRouter>, path: string) {
  yield* Effect.tryPromise(() => waitFor(() => expect(router.state.location.pathname).toBe(path)))
})

const selectProject = (name: string) => {
  const trigger = screen.getByRole("button", { name: /Active project:/ })
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(name) }))
}

const selectConversation = () => {
  fireEvent.click(screen.getByRole("button", { name: "Sidebar three-zone shape, unread" }))
}

describe("production automation routes", () => {
  it.effect.each(sections)("opens the direct automation URL %s", ([suffix, label]) =>
    Effect.scoped(Effect.gen(function* () {
      yield* mountApp(`/p/${alpha}/automations${suffix}`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: label }))
      expect(screen.getByText("alpha-project", { selector: "p" })).toBeDefined()
      expect(screen.getByRole("button", { name: "Automations" }).getAttribute("aria-current")).toBe("page")
      const navigation = screen.getByRole("navigation", { name: "Automation pages" })
      expect(within(navigation).getByRole("button", { name: label }).getAttribute("aria-current")).toBe("page")
      expect(screen.getByRole("link", { name: "Back to workspace" }).getAttribute("href")).toBe(`/p/${alpha}`)
    })))

  it.effect("opens overview from the rail and navigates all sections, workspace, back and forward", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router, history } = yield* mountApp(`/p/${alpha}`)
      fireEvent.click(screen.getByRole("button", { name: "Automations" }))
      yield* expectPath(router, `/p/${alpha}/automations`)
      for (const [suffix, label] of sections) {
        fireEvent.click(yield* Effect.tryPromise(() => screen.findByRole("button", { name: label })))
        yield* expectPath(router, `/p/${alpha}/automations${suffix}`)
        yield* Effect.tryPromise(() => screen.findByRole("heading", { name: label }))
      }
      fireEvent.click(screen.getByRole("link", { name: "Back to workspace" }))
      yield* expectPath(router, `/p/${alpha}`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "alpha-project" }))
      history.back()
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "History" }))
      history.forward()
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "alpha-project" }))
    })))

  it.effect.each(sections)("preserves section %s on project selection and clears preview", ([suffix, label]) =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${alpha}/automations${suffix}`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: label }))
      selectConversation()
      selectProject("beta-project")
      yield* expectPath(router, `/p/${beta}/automations${suffix}`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: label }))
      expect(screen.getByText("beta-project", { selector: "p" })).toBeDefined()
      expect(screen.queryByText("Conversation preview")).toBeNull()
    })))

  it.effect("keeps the full conversation article and returns to the prior automation section", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${alpha}/automations/history`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "History" }))
      selectConversation()
      const article = screen.getByRole("article")
      expect(within(article).getByRole("heading", { name: "Sidebar three-zone shape" })).toBeDefined()
      expect(within(article).getByText("Rail holds devices, the panel holds the project switcher and the worktree inbox.")).toBeDefined()
      expect(screen.queryByRole("navigation", { name: "Automation pages" })).toBeNull()
      expect(screen.getByRole("button", { name: "Automations" }).getAttribute("aria-current")).toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Back to automations" }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "History" }))
      expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/history`)
    })))

  it.effect("clears preview when the rail reopens overview at the same URL", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${alpha}/automations`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Overview" }))
      selectConversation()
      fireEvent.click(screen.getByRole("button", { name: "Automations" }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Overview" }))
      expect(screen.queryByText("Conversation preview")).toBeNull()
      expect(router.state.location.pathname).toBe(`/p/${alpha}/automations`)
    })))

  it.effect("keeps the route and clears preview on device switch", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${alpha}/automations/integrations`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Integrations" }))
      selectConversation()
      const device = screen.getByRole("button", { name: "Switch device, active: This machine" })
      fireEvent.pointerDown(device)
      fireEvent.click(device)
      fireEvent.click(screen.getByRole("menuitem", { name: /Field laptop/ }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Integrations" }))
      expect(router.state.location.pathname).toBe(`/p/${alpha}/automations/integrations`)
      expect(screen.getByRole("button", { name: "Switch device, active: Field laptop" })).toBeDefined()
    })))

  it.effect("keeps command palette project opening directed to workspace", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${alpha}/automations/history`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "History" }))
      selectConversation()
      useCommandPalette.setState({ open: true })
      const dialog = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Command Palette" }))
      fireEvent.click(within(dialog).getByText("alpha-project", { exact: true }))
      yield* expectPath(router, `/p/${alpha}`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "alpha-project" }))
      expect(screen.queryByText("Conversation preview")).toBeNull()
    })))

  it.effect("decodes encoded project IDs and names archived projects", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${encodedProject.replace(/^0/, "%30")}/automations/history`, true)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "History" }))
      expect(screen.getByRole("button", { name: "Active project: encoded-project" })).toBeDefined()
      yield* Effect.tryPromise(() => router.navigate({ to: "/p/$projectId/automations", params: { projectId: alpha } }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Overview" }))
      expect(screen.getByRole("button", { name: "Active project: alpha-project" })).toBeDefined()
    })))

  it.effect("opens the automation entry page from an unknown or deleted project", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router, context } = yield* mountApp("/p/missing/automations/history")
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Unknown project" }))
      expect(screen.getByRole("link", { name: "Projects" })).toBeDefined()
      expect(screen.queryByRole("navigation", { name: "Automation pages" })).toBeNull()
      const rail = screen.getByRole("button", { name: "Automations" })
      expect(rail.getAttribute("aria-disabled")).toBeNull()
      fireEvent.click(rail)
      yield* expectPath(router, "/automations")
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Automations" }))
      yield* Effect.tryPromise(() => router.navigate({ to: "/p/$projectId/automations", params: { projectId: alpha } }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Overview" }))
      context.store.setState({ projects: [], seq: 1 })
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Unknown project" }))
      expect(screen.queryByRole("navigation", { name: "Automation pages" })).toBeNull()
      expect(rail.getAttribute("aria-disabled")).toBeNull()
      fireEvent.click(rail)
      yield* expectPath(router, "/automations")
      yield* Effect.tryPromise(() => screen.findByRole("link", { name: "Create a project" }))
    })))

  it.effect("opens automations from the project list and enters a project overview", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp("/")
      const button = screen.getByRole("button", { name: "Automations" })
      button.focus()
      expect(document.activeElement).toBe(button)
      expect(button.getAttribute("aria-disabled")).toBeNull()
      fireEvent.click(button)
      yield* expectPath(router, "/automations")
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Automations" }))
      expect(button.getAttribute("aria-current")).toBe("page")
      expect(screen.getByRole("button", { name: "Select a project" })).toBeDefined()
      fireEvent.click(screen.getByRole("link", { name: "Open automations for beta-project" }))
      yield* expectPath(router, `/p/${beta}/automations`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Overview" }))
    })))

  it.effect("opens the direct global URL and keeps sidebar project selection in automations", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp("/automations")
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Automations" }))
      const trigger = screen.getByRole("button", { name: "Select a project" })
      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole("menuitem", { name: /alpha-project/ }))
      yield* expectPath(router, `/p/${alpha}/automations`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Overview" }))
    })))

  it.effect("keeps the global entry usable with no projects", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router, context } = yield* mountApp("/")
      context.store.setState({ projects: [], seq: 1 })
      fireEvent.click(screen.getByRole("button", { name: "Automations" }))
      yield* expectPath(router, "/automations")
      const create = yield* Effect.tryPromise(() => screen.findByRole("link", { name: "Create a project" }))
      fireEvent.click(create)
      yield* expectPath(router, "/")
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: /Projects \(0\)/ }))
    })))

  it.effect.each([`/p/${alpha}/automations-other`, `/p/${alpha}/automations/history-extra`])("does not mark unrelated path %s active", (path) =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* mountApp(`/p/${alpha}/automations/history`)
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "History" }))
      const rail = screen.getByRole("button", { name: "Automations" })
      expect(rail.getAttribute("aria-current")).toBe("page")
      router.history.push(path)
      yield* Effect.tryPromise(() => waitFor(() => expect(rail.getAttribute("aria-current")).toBeNull()))
    })))
})
