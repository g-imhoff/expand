import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { ProjectWorkspaceView } from "@yodea/tui/components/project-workspace-view"

describe("ProjectWorkspaceView", () => {
  it("shows the project name and the chat-seam placeholder", () => {
    const { lastFrame } = render(
      <ProjectWorkspaceView project={{ id: "p1", name: "alpha", createdAt: "t" }} />
    )
    expect(lastFrame()).toContain("alpha")
    expect(lastFrame()).toContain("coming soon")
  })
  it("handles a missing project", () => {
    const { lastFrame } = render(<ProjectWorkspaceView />)
    expect(lastFrame()).toContain("Unknown project")
  })
})
