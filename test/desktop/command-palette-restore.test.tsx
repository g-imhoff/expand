// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Project } from "@yodea/contracts/project"
import { ALL_PROJECTS_KEY } from "@yodea/desktop/renderer/features/projects/cache"
import { RpcContext } from "@yodea/desktop/renderer/rpc/runtime"
import { useCommandPalette } from "@yodea/desktop/renderer/command/store"

// useNavigate is the palette's only router dependency (used to open a project).
// Stub it so we can render the palette without a full RouterProvider; the Restore
// command we assert on never navigates.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }))

// Imported AFTER the router mock is registered so CommandPalette picks up the stub.
const { CommandPalette } = await import("@yodea/desktop/renderer/command/CommandPalette")

const project = (over: Partial<Project>): Project => ({
  id: "p1", name: "alpha", directory: null, description: null, tags: [],
  archived: false, createdAt: "t", updatedAt: "t", ...over
})

// Seed the palette's data source (ALL_PROJECTS_KEY, includeArchived) directly so
// useAllProjects() reads from cache (staleTime Infinity) and never fires the RPC.
const renderPalette = (projects: ReadonlyArray<Project>) => {
  const qc = new QueryClient()
  qc.setQueryData<ReadonlyArray<Project>>(ALL_PROJECTS_KEY, projects)
  // A non-null RpcContext value satisfies useRpc(); the stubbed cache means the
  // client/runtime are never actually called for the list.
  const rpc = { runtime: {} as never, client: {} as never }
  useCommandPalette.setState({ open: true })
  return render(
    <QueryClientProvider client={qc}>
      <RpcContext.Provider value={rpc}>
        <CommandPalette />
      </RpcContext.Provider>
    </QueryClientProvider>
  )
}

describe("CommandPalette — archived projects stay reachable", () => {
  it("surfaces a Restore command for an archived project", () => {
    // Regression: an archived project must remain in the palette so its Restore
    // command can be selected — archive must not be a one-way trip. Fails before
    // the fix, where the palette sourced useProjects() (archived excluded) and no
    // archived project (the only kind with a Restore command) was ever listed.
    const { getByText } = renderPalette([project({ id: "p1", name: "alpha", archived: true })])
    expect(getByText(/Restore “alpha”/)).toBeTruthy()
  })

  it("shows Archive (not Restore) for a live project — toggle keys off archived", () => {
    const { getByText, queryByText } = renderPalette([project({ id: "p2", name: "beta", archived: false })])
    expect(getByText(/Archive “beta”/)).toBeTruthy()
    expect(queryByText(/Restore “beta”/)).toBeNull()
  })
})
