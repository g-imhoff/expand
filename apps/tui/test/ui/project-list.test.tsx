import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { ProjectList } from "@expand/tui/components/project-list"
import { type Project } from "@expand/contracts/project"

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as string

describe("ProjectList", () => {
  it("shows an empty hint when there are no projects", () => {
    const view = render(<ProjectList projects={[]} focused={true} />)
    expect(view.lastFrame()).toContain("Projects (0)")
    expect(view.lastFrame()).toContain("press n to create one")
    view.unmount()
  })
  it("renders project names and count", () => {
    const projects: ReadonlyArray<Project> = [
      { id: uid(1), name: "alpha" as string, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as unknown as Project,
      { id: uid(2), name: "beta" as string, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as unknown as Project
    ]
    const view = render(<ProjectList projects={projects} focused={true} />)
    expect(view.lastFrame()).toContain("Projects (2)")
    expect(view.lastFrame()).toContain("alpha")
    expect(view.lastFrame()).toContain("beta")
    view.unmount()
  })
})
