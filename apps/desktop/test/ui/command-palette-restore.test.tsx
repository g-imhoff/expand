// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from "@testing-library/react"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect, vi } from "vitest"
import type { Project } from "@expand/contracts/project"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { useCommandPalette } from "@expand/desktop/renderer/features/command/model/command-store"
import { fakeProject, makeFakeProjectContext, renderWithProjectContext, uid } from "./_harness"

const navigate = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))

const { CommandPalette } = await import("@expand/desktop/renderer/features/command/components/CommandPalette")

const runner: RendererRunner = { start: startRendererRoot }

const renderPalette = (projects: ReadonlyArray<Project>) => {
  useCommandPalette.setState({ open: true })
  return renderWithProjectContext(
    <RendererRunnerProvider value={runner}>
      <CommandPalette />
    </RendererRunnerProvider>,
    makeFakeProjectContext(projects)
  )
}

describe("CommandPalette — archived projects stay reachable", () => {
  it("surfaces a Restore command for an archived project", () => {
    const { baseElement } = renderPalette([fakeProject({ id: uid(1), name: "alpha", archived: true })])
    expect(baseElement.textContent).toContain('Restore')
    expect(baseElement.textContent).toContain('alpha')
    expect(baseElement.textContent).not.toContain('Archive')
  })

  it("shows Archive (not Restore) for a live project — toggle keys off archived", () => {
    const { baseElement } = renderPalette([fakeProject({ id: uid(2), name: "beta", archived: false })])
    expect(baseElement.textContent).toContain('Archive')
    expect(baseElement.textContent).toContain('beta')
    expect(baseElement.textContent).not.toContain('Restore')
  })

  it.effect("observes a rejected navigation Promise through the owned runner", () =>
    Effect.gen(function* () {
      navigate.mockRejectedValueOnce(new Error("route unavailable"))
      renderPalette([fakeProject({ id: uid(3), name: "gamma", archived: false })])

      fireEvent.click(screen.getByText("gamma"))

      yield* Effect.tryPromise(() => waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain("route unavailable")
      }))
    }))
})
