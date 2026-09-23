// @vitest-environment happy-dom
import { useState } from "react"
import { it } from "@effect/vitest"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { fireEvent, screen, within } from "@testing-library/react"
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

describe("AppSidebar", () => {
  it.effect("switches the device from the top-left rail button", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSelectDevice = vi.fn()
      yield* renderSidebar({ activeDeviceId: "device-local", onSelectDevice })
      const trigger = screen.getByRole("button", { name: "Switch sample device, active: This machine" })
      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      const active = screen.getByRole("menuitem", { name: /This machine/ })
      expect(active.getAttribute("aria-current")).toBe("true")
      const other = screen.getByRole("menuitem", { name: /Field laptop/ })
      expect(other.getAttribute("aria-current")).toBeNull()
      fireEvent.click(other)
      expect(onSelectDevice).toHaveBeenCalledWith("device-field")
    })))

  it.effect("names the active project on the switcher and marks it in the menu", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSelectProject = vi.fn()
      yield* renderSidebar({ onSelectProject })
      const trigger = screen.getByRole("button", { name: "Active project: alpha" })
      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      const active = screen.getByRole("menuitem", { name: /alpha/ })
      expect(active.getAttribute("aria-current")).toBe("true")
      const other = screen.getByRole("menuitem", { name: /beta/ })
      expect(other.getAttribute("aria-current")).toBeNull()
      fireEvent.click(other)
      expect(onSelectProject).toHaveBeenCalledWith(uid(2))
    })))

  it.effect("shows the select-project state when no project is active", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({ activeProjectId: null })
      expect(screen.getByRole("button", { name: "Select a project" })).toBeDefined()
    })))

  it.effect("groups conversations by worktree and selects on click", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSelectConversation = vi.fn()
      yield* renderSidebar({ onSelectConversation })
      expect(screen.getByText("expand-sidebar")).toBeDefined()
      expect(screen.getByText("expand-auth")).toBeDefined()
      expect(screen.queryByText("expand-empty")).toBeNull()
      expect(screen.queryByText("No conversations found")).toBeNull()
      const row = screen.getByRole("button", { name: "Sidebar three-zone shape, unread" })
      expect(row.getAttribute("aria-current")).toBeNull()
      fireEvent.click(row)
      expect(onSelectConversation).toHaveBeenCalledWith("conv-sidebar-shape")
    })))

  it.effect("marks the controlled active conversation", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({ activeConversationId: "conv-auth-review" })
      expect(
        screen.getByRole("button", { name: "Auth flow review" }).getAttribute("aria-current")
      ).toBe("true")
    })))

  it.effect("clears an internal conversation selection when controlled with null", () =>
    Effect.scoped(Effect.gen(function* () {
      const SidebarWithClear = () => {
        const [cleared, setCleared] = useState(false)
        return (
          <SidebarProvider>
            <button type="button" onClick={() => setCleared(true)}>Clear selection</button>
            <AppSidebar activeProjectId={uid(1)} activeConversationId={cleared ? null : undefined} />
          </SidebarProvider>
        )
      }
      yield* renderWithProjectContextScoped(<SidebarWithClear />, makeFakeProjectContext(projects))
      const row = screen.getByRole("button", { name: "Auth flow review" })
      fireEvent.click(row)
      expect(row.getAttribute("aria-current")).toBe("true")
      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))
      expect(row.getAttribute("aria-current")).toBeNull()
    })))

  it.effect("filters conversations by search text", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({})
      fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "tokens" } })
      expect(screen.getByRole("button", { name: /Sidebar theme tokens/ })).toBeDefined()
      expect(screen.queryByRole("button", { name: /three-zone shape/ })).toBeNull()
    })))

  it.effect("limits the inbox to unreads when the filter is on", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({})
      fireEvent.click(screen.getByLabelText("Show unread conversations only"))
      expect(screen.getByRole("button", { name: /three-zone shape/ })).toBeDefined()
      expect(screen.queryByRole("button", { name: /^Auth flow review/ })).toBeNull()
    })))

  it.effect("marks fixture entries as samples and omits account controls", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({})
      expect(screen.getByText("Sample conversations")).toBeDefined()
      expect(screen.getAllByText("Sample").length).toBeGreaterThan(0)
      expect(screen.queryByText("Ada Lovelace")).toBeNull()
      expect(screen.queryByRole("button", { name: /account|notifications|log out/i })).toBeNull()
      const trigger = screen.getByRole("button", { name: "Switch sample device, active: This machine" })
      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      expect(screen.getByText("Sample devices")).toBeDefined()
      expect(screen.getByRole("menuitem", { name: /Studio server.*Sample/ })).toBeDefined()
    })))

  it.effect("does not mark supplied live entries as samples", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({
        devices: [{ id: "desktop", name: "Office desktop", kind: "local", status: "online" }],
        groups: [{
          id: "project-main",
          worktreeName: "project",
          branch: "main",
          conversations: [{
            id: "conversation",
            title: "Status update",
            teaser: "The current status",
            updatedAt: "Today",
            unread: false
          }]
        }]
      })
      expect(screen.getByText("Conversations")).toBeDefined()
      expect(screen.queryByText("Sample conversations")).toBeNull()
      expect(screen.queryByText("Sample")).toBeNull()
      const trigger = screen.getByRole("button", { name: "Switch device, active: Office desktop" })
      fireEvent.pointerDown(trigger)
      fireEvent.click(trigger)
      expect(screen.getByText("Devices")).toBeDefined()
      expect(screen.queryByText("Sample devices")).toBeNull()
    })))
})

describe("AppSidebar desktop toggle", () => {
  it.effect("collapses and expands from the visible device rail control", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar()
      const sidebar = document.querySelector('[data-slot="sidebar"][data-state]')
      const pane = document.querySelector('[aria-label="Project and conversations"]')
      expect(sidebar?.getAttribute("data-state")).toBe("expanded")
      expect(pane?.hasAttribute("inert")).toBe(false)
      expect(pane?.getAttribute("aria-hidden")).toBeNull()
      expect(screen.getByRole("button", { name: "Active project: alpha" })).toBeDefined()

      const collapse = screen.getByRole("button", { name: "Collapse sidebar" })
      expect(collapse.getAttribute("aria-expanded")).toBe("true")
      fireEvent.click(collapse)
      expect(sidebar?.getAttribute("data-state")).toBe("collapsed")
      expect(pane?.hasAttribute("inert")).toBe(true)
      expect(pane?.getAttribute("aria-hidden")).toBe("true")
      expect(screen.queryByRole("button", { name: "Active project: alpha" })).toBeNull()
      expect(screen.queryByRole("textbox", { name: "Search conversations" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Sidebar three-zone shape, unread" })).toBeNull()
      expect(screen.getByRole("button", { name: "Switch sample device, active: This machine" })).toBeDefined()

      const expand = screen.getByRole("button", { name: "Expand sidebar" })
      expect(expand.getAttribute("aria-expanded")).toBe("false")
      fireEvent.click(expand)
      expect(sidebar?.getAttribute("data-state")).toBe("expanded")
      expect(pane?.hasAttribute("inert")).toBe(false)
      expect(pane?.getAttribute("aria-hidden")).toBeNull()
      expect(screen.getByRole("button", { name: "Active project: alpha" })).toBeDefined()
      expect(screen.getByRole("textbox", { name: "Search conversations" })).toBeDefined()
      expect(screen.getByRole("button", { name: "Sidebar three-zone shape, unread" })).toBeDefined()
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeDefined()
    })))

  it.effect("keeps the mobile sheet accessible when the desktop sidebar state is collapsed", () =>
    Effect.scoped(Effect.gen(function* () {
      vi.stubGlobal("innerWidth", 390)
      yield* renderWithProjectContextScoped(
        <SidebarProvider defaultOpen={false}>
          <AppSidebar activeProjectId={uid(1)} />
        </SidebarProvider>,
        makeFakeProjectContext(projects)
      )

      fireEvent.keyDown(window, { key: "b", metaKey: true })
      const sheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      const pane = sheet.querySelector('[aria-label="Project and conversations"]')
      expect(pane?.hasAttribute("inert")).toBe(false)
      expect(pane?.getAttribute("aria-hidden")).toBeNull()
      expect(within(sheet).getByRole("button", { name: "Active project: alpha" })).toBeDefined()
      expect(within(sheet).getByRole("textbox", { name: "Search conversations" })).toBeDefined()
      expect(within(sheet).getByRole("button", { name: "Sidebar three-zone shape, unread" })).toBeDefined()
    })))
})
