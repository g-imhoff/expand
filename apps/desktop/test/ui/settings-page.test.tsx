// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { Effect } from "effect"
import { createMemoryHistory } from "@tanstack/react-router"
import { RouterProvider } from "@tanstack/react-router"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { createAppRouter } from "@expand/desktop/renderer/app/router"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { SidebarProvider } from "@expand/desktop/renderer/components/ui/sidebar"
import { AppSidebar } from "@expand/desktop/renderer/features/sidebar/components/AppSidebar"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import { fakeProject, makeFakeProjectContext, renderScoped, uid } from "./ui-harness"

const projects = [fakeProject({ id: uid(1), name: "alpha" })]

const automation = (over: Partial<AutomationRpcApi> = {}): Partial<AutomationRpcApi> => ({
  listCredentials: () => Effect.succeed({ credentials: [] }),
  integrationStatus: () => Effect.succeed({ ok: true, configured: true, owner: "octo", repo: "hello", labels: 3 }),
  putCredential: (() => Effect.succeed({ credentialId: "zen-api-key", version: 1, configured: true as const })) as unknown as AutomationRpcApi["putCredential"],
  ...over
})

const renderSettings = (rpc: Partial<AutomationRpcApi>, contextProjects = projects, initialEntries = ["/settings"]) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries }))
  return renderScoped(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <ProjectContextProvider value={makeFakeProjectContext(contextProjects, {}, rpc)}>
        <RouterProvider router={router} />
      </ProjectContextProvider>
    </RendererRunnerProvider>
  ).pipe(Effect.map((rendered) => ({ rendered, router })))
}

beforeEach(() => window.localStorage.removeItem("expand.theme"))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.removeItem("expand.theme")
  document.documentElement.classList.remove("dark")
})

describe("SettingsPage", () => {
  it.effect("defaults to dark mode and saves a theme choice without losing unsaved credentials", () =>
    Effect.scoped(Effect.gen(function* () {
      const { rendered } = yield* renderSettings(automation())
      yield* Effect.tryPromise(() => screen.findByLabelText("API key"))
      expect(document.documentElement.classList.contains("dark")).toBe(true)
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "unsaved-key" } })
      fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
      expect(screen.getByRole("heading", { name: "Appearance" })).toBeDefined()
      const toggle = screen.getByRole("switch", { name: "Dark mode" })
      expect(toggle.getAttribute("aria-checked")).toBe("true")
      fireEvent.click(toggle)
      expect(document.documentElement.classList.contains("dark")).toBe(false)
      expect(document.documentElement.style.colorScheme).toBe("light")
      expect(window.localStorage.getItem("expand.theme")).toBe("light")
      fireEvent.click(screen.getByRole("button", { name: "Connections" }))
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("unsaved-key")

      rendered.unmount()
      yield* renderSettings(automation())
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Appearance" }))
      fireEvent.click(screen.getByRole("button", { name: "Appearance" }))
      expect(screen.getByRole("switch", { name: "Dark mode" }).getAttribute("aria-checked")).toBe("false")
      expect(document.documentElement.classList.contains("dark")).toBe(false)
      fireEvent.click(screen.getByRole("switch", { name: "Dark mode" }))
      expect(document.documentElement.classList.contains("dark")).toBe(true)
      expect(window.localStorage.getItem("expand.theme")).toBe("dark")
    })))

  it.effect("keeps the theme toggle usable when preference storage is unavailable", () =>
    Effect.scoped(Effect.gen(function* () {
      vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage unavailable") })
      vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage unavailable") })
      yield* renderSettings(automation())
      fireEvent.click(yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Appearance" })))
      expect(document.documentElement.classList.contains("dark")).toBe(true)
      fireEvent.click(screen.getByRole("switch", { name: "Dark mode" }))
      expect(document.documentElement.classList.contains("dark")).toBe(false)
    })))

  it.effect("renders a dedicated settings page with sidebar navigation", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSettings(automation())
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Connections" }))
      const navigation = screen.getByRole("navigation", { name: "Settings sections" })
      expect(within(navigation).getByRole("button", { name: "Connections" }).getAttribute("aria-current")).toBe("true")
      expect(within(navigation).getByRole("button", { name: "Backend" })).toBeDefined()
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.queryByRole("button", { name: "Settings" })).toBeNull()
      expect(screen.getByRole("heading", { name: "GitHub" })).toBeDefined()
      expect(screen.getByRole("heading", { name: "Zen" })).toBeDefined()
      expect(screen.queryByLabelText("Personal access token")).toBeNull()
      expect(screen.getByText("GitHub OAuth needs backend support", { exact: false })).toBeDefined()
    })))

  it.effect("switches sidebar sections and preserves an unsaved Zen key", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSettings(automation())
      yield* Effect.tryPromise(() => screen.findByLabelText("API key"))
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "unsaved-key" } })
      fireEvent.click(screen.getByRole("button", { name: "Backend" }))
      expect(screen.getByRole("heading", { name: "Backend" })).toBeDefined()
      expect(screen.getByText("Active backend: local")).toBeDefined()
      expect(screen.getByRole("button", { name: "Backend" }).getAttribute("aria-current")).toBe("true")
      expect(screen.queryByRole("heading", { name: "GitHub" })).toBeNull()
      fireEvent.click(screen.getByRole("button", { name: "Connections" }))
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("unsaved-key")
    })))

  it.effect("keeps settings sections accessible when the sidebar is collapsed", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSettings(automation())
      const toggle = yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Toggle settings sidebar" }))
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
      fireEvent.click(toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      fireEvent.click(screen.getByRole("button", { name: "Backend" }))
      expect(screen.getByRole("heading", { name: "Backend" })).toBeDefined()
      fireEvent.click(toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe("true")
    })))

  it.effect("opens navigation in a left sheet on narrow windows and closes it after selection", () =>
    Effect.scoped(Effect.gen(function* () {
      vi.stubGlobal("innerWidth", 390)
      yield* renderSettings(automation())
      const toggle = yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Toggle settings sidebar" }))
      expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull()
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      fireEvent.click(toggle)
      const sheet = yield* Effect.tryPromise(() => screen.findByRole("dialog", { name: "Sidebar" }))
      fireEvent.click(within(sheet).getByRole("button", { name: "Backend" }))
      expect(screen.getByRole("heading", { name: "Backend" })).toBeDefined()
      expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull()
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      yield* Effect.tryPromise(() => waitFor(() => expect(document.activeElement).toBe(toggle)))
    })))

  it.effect("returns to the previous workspace", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* renderSettings(automation(), projects, [`/p/${uid(1)}`])
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "alpha" }))
      fireEvent.click(screen.getByRole("button", { name: "Settings" }))
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Back" }))
      fireEvent.click(screen.getByRole("button", { name: "Back" }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "alpha" }))
      expect(router.state.location.pathname).toBe(`/p/${uid(1)}`)
    })))

  it.effect("returns to projects when settings is the initial route", () =>
    Effect.scoped(Effect.gen(function* () {
      const { router } = yield* renderSettings(automation())
      yield* Effect.tryPromise(() => screen.findByRole("button", { name: "Back" }))
      fireEvent.click(screen.getByRole("button", { name: "Back" }))
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: /Projects \(1\)/ }))
      expect(router.state.location.pathname).toBe("/")
    })))

  it.effect("saves general credentials without choosing a project", () =>
    Effect.scoped(Effect.gen(function* () {
      const putCredential = vi.fn(automation().putCredential!)
      yield* renderSettings(automation({ putCredential }), [
        ...projects,
        fakeProject({ id: uid(2), name: "beta" }),
        fakeProject({ id: uid(3), name: "archived", archived: true })
      ])
      yield* Effect.tryPromise(() => screen.findByLabelText("API key"))
      expect(screen.queryByRole("combobox")).toBeNull()
      expect(screen.queryByText(/this project's/i)).toBeNull()
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "general-key" } })
      fireEvent.click(screen.getByRole("button", { name: "Save Zen API key" }))
      expect(putCredential).toHaveBeenCalledWith(expect.objectContaining({ scope: { ownerId: "local", projectId: "__global__" } }))
    })))

  it.effect("saves the Zen key write-only and clears the field", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<unknown> = []
      yield* renderSettings(automation({
        putCredential: ((payload: unknown) => {
          seen.push(payload)
          return Effect.succeed({ credentialId: "zen-api-key", version: 1, configured: true as const })
        }) as unknown as AutomationRpcApi["putCredential"]
      }))
      yield* Effect.tryPromise(() => screen.findByLabelText("API key"))
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "zen-secret" } })
      fireEvent.click(screen.getByRole("button", { name: "Save Zen API key" }))
      expect(seen.length).toBe(1)
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("")
    })))

  it.effect("loads and saves settings before any project exists", () =>
    Effect.scoped(Effect.gen(function* () {
      const putCredential = vi.fn(automation().putCredential!)
      yield* renderSettings(automation({ putCredential }), [])
      yield* Effect.tryPromise(() => screen.findByLabelText("API key"))
      expect(screen.queryByRole("combobox")).toBeNull()
      expect(screen.queryByText("Create a project first.", { exact: false })).toBeNull()
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "general-key" } })
      fireEvent.click(screen.getByRole("button", { name: "Save Zen API key" }))
      expect(putCredential).toHaveBeenCalledWith(expect.objectContaining({ scope: { ownerId: "local", projectId: "__global__" } }))
      fireEvent.click(screen.getByRole("button", { name: "Backend" }))
      expect(screen.getByText("Active backend: local")).toBeDefined()
    })))

  it.effect("replaces a saved general API key using its current version", () =>
    Effect.scoped(Effect.gen(function* () {
      const putCredential = vi.fn(automation().putCredential!)
      const listCredentials = vi.fn(() => Effect.succeed({ credentials: [{ credentialId: "zen-api-key", version: 2, configured: true as const }] }))
      yield* renderSettings(automation({ listCredentials, putCredential }), [])
      yield* Effect.tryPromise(() => screen.findByLabelText("API key"))
      expect(listCredentials).toHaveBeenCalledWith({ scope: { ownerId: "local", projectId: "__global__" } })
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: "replacement-key" } })
      fireEvent.click(screen.getByRole("button", { name: "Save Zen API key" }))
      expect(putCredential).toHaveBeenCalledWith({ scope: { ownerId: "local", projectId: "__global__" }, credentialId: "zen-api-key", secret: "replacement-key", expectedVersion: 2 })
    })))
})

describe("SettingsRail", () => {
  it.effect("opens settings from the rail gear", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenSettings = vi.fn()
      yield* renderScoped(
        <ProjectContextProvider value={makeFakeProjectContext(projects)}>
          <SidebarProvider>
            <AppSidebar activeProjectId={uid(1)} onOpenSettings={onOpenSettings} />
          </SidebarProvider>
        </ProjectContextProvider>
      )
      const button = screen.getByRole("button", { name: "Settings" })
      expect(button.getAttribute("aria-current")).toBeNull()
      fireEvent.click(button)
      expect(onOpenSettings).toHaveBeenCalledOnce()
    })))

  it.effect("marks settings active on the settings route", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderScoped(
        <ProjectContextProvider value={makeFakeProjectContext(projects)}>
          <SidebarProvider>
            <AppSidebar activeProjectId={uid(1)} settingsActive onOpenSettings={vi.fn()} />
          </SidebarProvider>
        </ProjectContextProvider>
      )
      expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-current")).toBe("page")
    })))
})
