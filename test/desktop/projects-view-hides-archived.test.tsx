// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Project } from "@yodea/contracts/project"
import { PROJECTS_KEY } from "@yodea/desktop/renderer/features/projects/cache"
import { RpcContext } from "@yodea/desktop/renderer/rpc/runtime"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))

const { ProjectsView } = await import("@yodea/desktop/renderer/features/projects/projects-view")

const project = (over: Partial<Project>): Project => ({
  id: "p1", name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t", ...over
})

const renderView = (projects: ReadonlyArray<Project>) => {
  const qc = new QueryClient()
  qc.setQueryData<ReadonlyArray<Project>>(PROJECTS_KEY, projects)
  const rpc = { runtime: {} as never, client: {} as never }
  return render(
    <QueryClientProvider client={qc}>
      <RpcContext.Provider value={rpc}>
        <ProjectsView />
      </RpcContext.Provider>
    </QueryClientProvider>
  )
}

describe("ProjectsView — default index view hides archived", () => {
  it("excludes an archived project from the list and the header count", () => {
    const { getByTestId, getByText } = renderView([
      project({ id: "live", name: "live-project", archived: false }),
      project({ id: "arch", name: "archived-project", archived: true })
    ])

    const list = getByTestId("project-list")
    expect(list.textContent).toContain("live-project")
    expect(list.textContent).not.toContain("archived-project")
    expect(getByText(/Projects \(1\)/)).toBeTruthy()
  })
})
