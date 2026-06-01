import { describe, expect, it, vi } from "vitest"
import type { CommandContext } from "@yodea/tui/commands/types"
import { dispatch, suggestionsFor } from "@yodea/tui/commands/registry"

const makeCtx = (list: ReadonlyArray<{ id: string; name: string; createdAt: string }> = []) => {
  const calls = {
    navigate: vi.fn(),
    create: vi.fn(),
    setError: vi.fn(),
    setNotice: vi.fn(),
    exit: vi.fn(),
    submitMessage: vi.fn(),
  }
  const ctx: CommandContext = {
    navigate: calls.navigate,
    projects: { list, create: calls.create },
    setError: calls.setError,
    setNotice: calls.setNotice,
    exit: calls.exit,
    submitMessage: calls.submitMessage,
  }
  return { ctx, calls }
}

describe("registry dispatch", () => {
  it("/new <name> calls projects.create", () => {
    const { ctx, calls } = makeCtx()
    dispatch("new", ["alpha"], ctx)
    expect(calls.create).toHaveBeenCalledWith("alpha")
  })
  it("/new with no name reports an error", () => {
    const { ctx, calls } = makeCtx()
    dispatch("new", [], ctx)
    expect(calls.setError).toHaveBeenCalled()
    expect(calls.create).not.toHaveBeenCalled()
  })
  it("/open resolves by name and navigates", () => {
    const { ctx, calls } = makeCtx([{ id: "p1", name: "alpha", createdAt: "t" }])
    dispatch("open", ["alpha"], ctx)
    expect(calls.navigate).toHaveBeenCalledWith({ kind: "projectWorkspace", projectId: "p1" })
  })
  it("/open with no match reports an error", () => {
    const { ctx, calls } = makeCtx([])
    dispatch("open", ["ghost"], ctx)
    expect(calls.setError).toHaveBeenCalled()
    expect(calls.navigate).not.toHaveBeenCalled()
  })
  it("/projects navigates to the list", () => {
    const { ctx, calls } = makeCtx()
    dispatch("projects", [], ctx)
    expect(calls.navigate).toHaveBeenCalledWith({ kind: "projectList" })
  })
  it("/quit exits", () => {
    const { ctx, calls } = makeCtx()
    dispatch("quit", [], ctx)
    expect(calls.exit).toHaveBeenCalled()
  })
  it("an unknown command reports an error", () => {
    const { ctx, calls } = makeCtx()
    dispatch("frobnicate", [], ctx)
    expect(calls.setError).toHaveBeenCalledWith('Unknown command: /frobnicate')
  })
})

describe("suggestionsFor", () => {
  it("returns nothing for non-slash buffers", () => {
    expect(suggestionsFor("hello")).toEqual([])
  })
  it("prefix-filters command names", () => {
    expect(suggestionsFor("/pro").map((c) => c.name)).toEqual(["projects"])
    expect(suggestionsFor("/").length).toBeGreaterThan(1)
  })
})
