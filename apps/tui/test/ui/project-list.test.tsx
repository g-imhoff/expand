import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { ProjectList } from "@yodea/tui/components/project-list"
import { type Project, type ProjectId, type ProjectName } from "@yodea/contracts/project"

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ProjectId

describe("ProjectList", () => {
  it("shows an empty hint when there are no projects", () => {
    const { lastFrame } = render(<ProjectList projects={[]} />)
    expect(lastFrame()).toContain("Projects (0)")
    expect(lastFrame()).toContain("no projects yet")
  })
  it("renders project names and count", () => {
    const projects: ReadonlyArray<Project> = [
      { id: uid(1), name: "alpha" as ProjectName, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as unknown as Project,
      { id: uid(2), name: "beta" as ProjectName, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as unknown as Project
    ]
    const { lastFrame } = render(<ProjectList projects={projects} />)
    expect(lastFrame()).toContain("Projects (2)")
    expect(lastFrame()).toContain("alpha")
    expect(lastFrame()).toContain("beta")
  })
})
