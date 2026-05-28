import { describe, expect, it } from "vitest"
import { projectSessions } from "@yodea/domain/session"
import { SessionCreated } from "@yodea/shared/events"

describe("projectSessions", () => {
  it("folds an empty log into no sessions", () => {
    expect(projectSessions([])).toEqual([])
  })

  it("folds SessionCreated events into the read-model", () => {
    const sessions = projectSessions([
      SessionCreated.make({ sessionId: "s1", title: "A", createdAt: "t1" }),
      SessionCreated.make({ sessionId: "s2", title: "B", createdAt: "t2" })
    ])
    expect(sessions).toEqual([
      { id: "s1", title: "A", createdAt: "t1" },
      { id: "s2", title: "B", createdAt: "t2" }
    ])
  })
})
