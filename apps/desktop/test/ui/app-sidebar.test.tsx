// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { beforeEach, describe, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect } from "effect"
import { SidebarProvider } from "@expand/desktop/renderer/components/ui/sidebar"
import { AppSidebar } from "@expand/desktop/renderer/features/sidebar/components/AppSidebar"
import { defaultSidebarWorktrees } from "@expand/desktop/renderer/features/sidebar/data/sidebar-data"
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

describe("AppSidebar", () => {
  it.effect("switches the device from the top-left rail button", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSelectDevice = vi.fn()
      yield* renderSidebar({ activeDeviceId: "device-local", onSelectDevice })
      const trigger = screen.getByRole("button", { name: "Switch device, active: This machine" })
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

  it.effect("renders the user footer with initials", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSidebar({})
      expect(screen.getByText("Ada Lovelace")).toBeDefined()
      expect(screen.getByText("AL")).toBeDefined()
    })))
})
