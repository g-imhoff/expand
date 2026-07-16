// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { Project } from "@expand/contracts/project"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { fakeProject, makeFakeProjectContext, renderWithProjectContext, uid } from "./_harness"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))

const { ProjectsView } = await import("@expand/desktop/renderer/features/projects/pages/ProjectsView")

const runner: RendererRunner = { start: startRendererRoot }

const renderView = (projects: ReadonlyArray<Project>) =>
  renderWithProjectContext(
    <RendererRunnerProvider value={runner}>
      <ProjectsView />
    </RendererRunnerProvider>,
    makeFakeProjectContext(projects)
  )

describe("ProjectsView — default index view hides archived", () => {
  it("excludes an archived project from the list and the header count", () => {
    const { getByTestId, getByText } = renderView([
      fakeProject({ id: uid(1), name: "live-project", archived: false }),
      fakeProject({ id: uid(2), name: "archived-project", archived: true })
    ])

    const list = getByTestId("project-list")
    expect(list.textContent).toContain("live-project")
    expect(list.textContent).not.toContain("archived-project")
    expect(getByText(/Projects \(1\)/)).toBeTruthy()
  })
})
