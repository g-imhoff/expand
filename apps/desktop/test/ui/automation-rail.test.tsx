// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect } from "effect"
import { SidebarProvider } from "@expand/desktop/renderer/components/ui/sidebar"
import { AppSidebar } from "@expand/desktop/renderer/features/sidebar/components/AppSidebar"
import { fakeProject, makeFakeProjectContext, renderWithProjectContextScoped, uid } from "./ui-harness"

const projects = [
  fakeProject({ id: uid(1), name: "alpha" }),
  fakeProject({ id: uid(2), name: "beta" })
]

const renderSidebar = (
  over: Partial<React.ComponentProps<typeof AppSidebar>> = {},
  contextProjects = projects
) =>
  renderWithProjectContextScoped(
    <SidebarProvider>
      <AppSidebar activeProjectId={uid(1)} {...over} />
    </SidebarProvider>,
    makeFakeProjectContext(contextProjects)
  )

beforeEach(() => {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      })
    })
  }
})

afterEach(() => vi.unstubAllGlobals())

describe("AutomationRail", () => {
  it.effect("opens project automations from the icon in the device rail", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenAutomations = vi.fn()
      yield* renderSidebar({ onOpenAutomations })
      const button = screen.getByRole("button", { name: "Automations" })
      const pane = document.querySelector('[aria-label="Project and conversations"]')
      expect(pane?.contains(button)).toBe(false)
      expect(button.closest('[data-slot="sidebar"]')?.contains(
        screen.getByRole("button", { name: "Switch device, active: This machine" })
      )).toBe(true)
      expect(button.textContent).toBe("")
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
      expect(button.getAttribute("aria-current")).toBeNull()
      fireEvent.click(button)
      expect(onOpenAutomations).toHaveBeenCalledExactlyOnceWith(uid(1))
      expect(screen.getByRole("button", { name: "Active project: alpha" })).toBeDefined()
      expect(screen.getByRole("textbox", { name: "Search conversations" })).toBeDefined()
    })))

  it.effect("marks automation active and keeps it reachable with the pane collapsed", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenAutomations = vi.fn()
      yield* renderSidebar({ onOpenAutomations, automationsActive: true })
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }))
      const button = screen.getByRole("button", { name: "Automations" })
      expect(button.getAttribute("aria-current")).toBe("page")
      expect(button.getAttribute("data-active")).toBe("true")
      fireEvent.click(button)
      expect(onOpenAutomations).toHaveBeenCalledExactlyOnceWith(uid(1))
      expect(screen.queryByRole("textbox", { name: "Search conversations" })).toBeNull()
    })))

  it.effect("opens automations without an active project", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenAutomations = vi.fn()
      yield* renderSidebar({ activeProjectId: null, onOpenAutomations })
      const button = screen.getByRole("button", { name: "Automations" })
      expect(button.getAttribute("aria-disabled")).toBeNull()
      button.focus()
      expect(document.activeElement).toBe(button)
      const tooltip = yield* Effect.tryPromise(() => screen.findByRole("tooltip"))
      expect(tooltip.textContent).toBe("Automations")
      fireEvent.click(button)
      expect(onOpenAutomations).toHaveBeenCalledExactlyOnceWith(null)
    })))

  it.effect("shows the automation tooltip when the expanded rail receives focus", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({ onOpenAutomations: vi.fn() })
      const button = screen.getByRole("button", { name: "Automations" })
      button.focus()
      const tooltip = yield* Effect.tryPromise(() => screen.findByRole("tooltip"))
      expect(tooltip.textContent).toBe("Automations")
    })))
})
