// @vitest-environment happy-dom
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { createAppRouter } from "@expand/desktop/renderer/app/router"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { fakeProject, makeFakeProjectContext, renderWithProjectContextScoped, uid } from "./ui-harness"

const runner: RendererRunner = { start: startRendererRoot }

const renderMobileShell = () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/p/${uid(1)}`] }))

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

  it.effect("opens automations from the mobile rail, closes the Sheet and returns focus", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderMobileShell()
      const trigger = yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Open sidebar" }))
      fireEvent.click(trigger)
      const sheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      fireEvent.click(within(sheet).getByRole("button", { name: "Automations" }))
      yield* Effect.tryPromise(() => waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
        expect(screen.getByRole("heading", { name: "Overview" })).toBeDefined()
        expect(document.activeElement).toBe(trigger)
      }))
      fireEvent.click(trigger)
      const reopened = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      fireEvent.click(within(reopened).getByRole("button", { name: "Sidebar three-zone shape, unread" }))
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Back to automations" }))
      fireEvent.click(trigger)
      const previewSheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      fireEvent.click(within(previewSheet).getByRole("button", { name: "Automations" }))
      yield* Effect.tryPromise(() => waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
        expect(screen.getByRole("heading", { name: "Overview" })).toBeDefined()
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
