import { describe, expect, it } from "vitest"
import { appReducer, initialAppState } from "@yodea/tui/app-state"

describe("appReducer", () => {
  it("starts on the project list", () => {
    expect(initialAppState).toEqual({ screen: { kind: "projectList" } })
  })
  it("navigates and clears transients", () => {
    const dirty = { screen: { kind: "projectList" as const }, transientError: "boom", notice: "hi" }
    expect(appReducer(dirty, { type: "navigate", screen: { kind: "projectWorkspace", projectId: "p1" } }))
      .toEqual({ screen: { kind: "projectWorkspace", projectId: "p1" } })
  })
  it("sets an error (clearing any notice) and a notice (clearing any error)", () => {
    const base = { screen: { kind: "projectList" as const } }
    expect(appReducer(base, { type: "setError", message: "nope" }))
      .toEqual({ screen: { kind: "projectList" }, transientError: "nope" })
    expect(appReducer({ ...base, transientError: "nope" }, { type: "setNotice", message: "soon" }))
      .toEqual({ screen: { kind: "projectList" }, notice: "soon" })
  })
  it("clears transients without touching the screen", () => {
    const dirty = { screen: { kind: "projectWorkspace" as const, projectId: "p1" }, transientError: "x" }
    expect(appReducer(dirty, { type: "clearTransients" }))
      .toEqual({ screen: { kind: "projectWorkspace", projectId: "p1" } })
  })
})
