import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { ProjectList } from "@yodea/tui/components/project-list"

describe("ProjectList", () => {
  it("shows an empty hint when there are no projects", () => {
    const { lastFrame } = render(<ProjectList projects={[]} />)
    expect(lastFrame()).toContain("Projects (0)")
    expect(lastFrame()).toContain("no projects yet")
  })
  it("renders project names and count", () => {
    const projects = [
      { id: "p1", name: "alpha", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" },
      { id: "p2", name: "beta", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }
    ]
    const { lastFrame } = render(<ProjectList projects={projects} />)
    expect(lastFrame()).toContain("Projects (2)")
    expect(lastFrame()).toContain("alpha")
    expect(lastFrame()).toContain("beta")
  })
})
