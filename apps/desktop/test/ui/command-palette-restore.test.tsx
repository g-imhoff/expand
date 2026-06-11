// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest"
import type { Project } from "@yodea/contracts/project"
import { useCommandPalette } from "@yodea/desktop/renderer/features/command/model/command-store"
import { fakeProject, makeFakeAppHandle, renderWithHandle, uid } from "./_harness"

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }))

const { CommandPalette } = await import("@yodea/desktop/renderer/features/command/components/CommandPalette")

const renderPalette = (projects: ReadonlyArray<Project>) => {
  useCommandPalette.setState({ open: true })
  return renderWithHandle(<CommandPalette />, makeFakeAppHandle(projects))
}

describe("CommandPalette — archived projects stay reachable", () => {
  it("surfaces a Restore command for an archived project", () => {
    const { baseElement } = renderPalette([fakeProject({ id: uid(1), name: "alpha", archived: true })])
    expect(baseElement.textContent).toContain('Restore')
    expect(baseElement.textContent).toContain('alpha')
    expect(baseElement.textContent).not.toContain('Archive "alpha"')
  })

  it("shows Archive (not Restore) for a live project — toggle keys off archived", () => {
    const { baseElement } = renderPalette([fakeProject({ id: uid(2), name: "beta", archived: false })])
    expect(baseElement.textContent).toContain('Archive')
    expect(baseElement.textContent).toContain('beta')
    expect(baseElement.textContent).not.toContain('Restore "beta"')
  })
})
