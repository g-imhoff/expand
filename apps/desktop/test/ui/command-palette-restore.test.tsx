// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { Project } from "@yodea/contracts/project"
import { useCommandPalette } from "@yodea/desktop/renderer/features/command/model/command-store"
import { fakeProject, makeFakeAppHandle, renderWithHandle } from "./_harness"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }))

const { CommandPalette } = await import("@yodea/desktop/renderer/features/command/components/CommandPalette")

const renderPalette = (projects: ReadonlyArray<Project>) => {
  useCommandPalette.setState({ open: true })
  return renderWithHandle(<CommandPalette />, makeFakeAppHandle(projects))
}

describe("CommandPalette — archived projects stay reachable", () => {
  it("surfaces a Restore command for an archived project", () => {
    const { getByText } = renderPalette([fakeProject({ id: "p1", name: "alpha", archived: true })])
    expect(getByText(/Restore “alpha”/)).toBeTruthy()
  })

  it("shows Archive (not Restore) for a live project — toggle keys off archived", () => {
    const { getByText, queryByText } = renderPalette([fakeProject({ id: "p2", name: "beta", archived: false })])
    expect(getByText(/Archive “beta”/)).toBeTruthy()
    expect(queryByText(/Restore “beta”/)).toBeNull()
  })
})
