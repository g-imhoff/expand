import { describe, expect, it } from "vitest"
import { render } from "ink-testing-library"
import { StatusLine } from "@yodea/tui/components/status-line"

describe("StatusLine", () => {
  it("shows the projects title on the list screen", () => {
    const { lastFrame } = render(<StatusLine screen={{ kind: "projectList" }} />)
    expect(lastFrame()).toContain("Yodea")
  })
  it("shows the active project name on the workspace screen", () => {
    const { lastFrame } = render(
      <StatusLine screen={{ kind: "projectWorkspace", projectId: "p1" }} projectName="alpha" />
    )
    expect(lastFrame()).toContain("project: alpha")
  })
  it("renders a transient error, and a notice only when no error", () => {
    const err = render(<StatusLine screen={{ kind: "projectList" }} transientError="boom" notice="hi" />)
    expect(err.lastFrame()).toContain("boom")
    expect(err.lastFrame()).not.toContain("hi")
    const note = render(<StatusLine screen={{ kind: "projectList" }} notice="hello" />)
    expect(note.lastFrame()).toContain("hello")
  })
})
