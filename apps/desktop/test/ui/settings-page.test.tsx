// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
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

const renderSettings = (rpc: Partial<AutomationRpcApi>, contextProjects = projects) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/settings"] }))
  return renderScoped(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <ProjectContextProvider value={makeFakeProjectContext(contextProjects, {}, rpc)}>
        <RouterProvider router={router} />
      </ProjectContextProvider>
    </RendererRunnerProvider>
  )
}

describe("SettingsPage", () => {
  it.effect("renders the global connection page without any pasted GitHub token field", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSettings(automation())
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Settings" }))
      expect(screen.getByRole("heading", { name: "GitHub" })).toBeDefined()
      expect(screen.getByRole("heading", { name: "Zen" })).toBeDefined()
      expect(screen.queryByLabelText("Personal access token")).toBeNull()
      expect(screen.getByText("GitHub OAuth needs backend support", { exact: false })).toBeDefined()
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

  it.effect("asks for a project when none exists", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderSettings(automation(), [])
      yield* Effect.tryPromise(() => screen.findByText("Create a project first.", { exact: false }))
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
