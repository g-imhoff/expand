// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { RootLayout } from "@expand/desktop/renderer/app/shell/root-layout"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { ProjectsView } from "@expand/desktop/renderer/features/projects/pages/ProjectsView"
import { Workspace } from "@expand/desktop/renderer/features/projects/pages/Workspace"
import { fakeProject, makeFakeProjectContext, renderWithProjectContextScoped, uid } from "./ui-harness"

const runner: RendererRunner = { start: startRendererRoot }

const renderMobileShell = () => {
  const rootRoute = createRootRoute({ component: RootLayout })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ProjectsView })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/p/$projectId",
    component: Workspace
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, projectRoute]),
    history: createMemoryHistory({ initialEntries: [`/p/${uid(1)}`] })
  })

  return renderWithProjectContextScoped(
    <RendererRunnerProvider value={runner}>
      <RouterProvider router={router} />
    </RendererRunnerProvider>,
    makeFakeProjectContext([
      fakeProject({ id: uid(1), name: "alpha" }),
      fakeProject({ id: uid(2), name: "beta" })
    ])
  )
}

beforeEach(() => {
  vi.stubGlobal("innerWidth", 390)
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe("mobile app shell", () => {
  it.effect("opens the sidebar Sheet and reaches its project and conversation controls", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderMobileShell()
      const trigger = yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Open sidebar" }))
      expect(trigger.getAttribute("aria-expanded")).toBe("false")

      fireEvent.click(trigger)
      const sheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      expect(trigger.getAttribute("aria-expanded")).toBe("true")
      expect(sheet.getAttribute("data-mobile")).toBe("true")
      expect(within(sheet).getByRole("button", { name: "Active project: alpha" })).toBeDefined()

      const conversation = within(sheet).getByRole("button", { name: "Sidebar three-zone shape, unread" })
      fireEvent.click(conversation)
      yield* Effect.tryPromise(() => waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("false")
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
        expect(screen.getByRole("heading", { name: "Sidebar three-zone shape" })).toBeDefined()
        expect(document.activeElement).toBe(trigger)
      }))

      fireEvent.click(trigger)
      const projectSheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      expect(within(projectSheet).getByRole("button", { name: "Sidebar three-zone shape, unread" }).getAttribute("aria-current")).toBe("true")
      const project = within(projectSheet).getByRole("button", { name: "Active project: alpha" })
      fireEvent.pointerDown(project)
      fireEvent.click(project)
      fireEvent.click(screen.getByRole("menuitem", { name: /beta/ }))

      yield* Effect.tryPromise(() => waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("false")
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
        expect(document.activeElement).toBe(trigger)
      }))

      fireEvent.click(trigger)
      const reopenedSheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      expect(within(reopenedSheet).getByRole("button", { name: "Active project: beta" })).toBeDefined()
      fireEvent.click(within(reopenedSheet).getByRole("button", { name: "Close" }))
      yield* Effect.tryPromise(() => waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("false")
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
        expect(document.activeElement).toBe(trigger)
      }))
    })))

  it.effect("returns focus to the opener after Escape closes the sidebar", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderMobileShell()
      const trigger = yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Open sidebar" }))
      trigger.focus()
      fireEvent.click(trigger)
      const sheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      expect(sheet.contains(document.activeElement)).toBe(true)

      fireEvent.keyDown(document.activeElement ?? sheet, { key: "Escape" })
      yield* Effect.tryPromise(() => waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
        expect(document.activeElement).toBe(trigger)
      }))
    })))
})
