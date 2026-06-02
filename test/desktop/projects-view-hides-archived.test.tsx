// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Project } from "@yodea/contracts/project"
import { PROJECTS_KEY } from "@yodea/desktop/renderer/features/projects/cache"
import { RpcContext } from "@yodea/desktop/renderer/rpc/runtime"

// Link is ProjectsView's only router dependency (it builds per-row project
// links). Stub it as a plain anchor so we can render the view without a full
// RouterProvider — mirrors how command-palette-restore.test.tsx stubs
// useNavigate. The link target is irrelevant to the archived-visibility assertion.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))

// Imported AFTER the router mock is registered so ProjectsView picks up the stub.
const { ProjectsView } = await import("@yodea/desktop/renderer/features/projects/projects-view")

const project = (over: Partial<Project>): Project => ({
  id: "p1", name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t", ...over
})

// Seed the default list (PROJECTS_KEY) directly so useProjects() reads from cache
// (staleTime Infinity) and never fires the RPC — mirrors the palette test. This
// reproduces the live-event-fold state where a just-archived project still sits
// in PROJECTS_KEY with archived:true before the invalidation refetch lands.
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
    // Regression: after a live ProjectArchived event the renderer's fold keeps the
    // project in PROJECTS_KEY with archived:true. The default index view must hide
    // it consistently (matching the CLI/backend default + the useProjects() refetch
    // path) rather than lingering it unmarked until the invalidation refetch.
    // Fails before the fix, where the view rendered PROJECTS_KEY UNFILTERED.
    const { getByTestId, getByText } = renderView([
      project({ id: "live", name: "live-project", archived: false }),
      project({ id: "arch", name: "archived-project", archived: true })
    ])

    const list = getByTestId("project-list")
    expect(list.textContent).toContain("live-project")
    expect(list.textContent).not.toContain("archived-project")
    // Header counts only the non-archived (visible) projects: 1 of the 2 seeded.
    expect(getByText(/Projects \(1\)/)).toBeTruthy()
  })
})
