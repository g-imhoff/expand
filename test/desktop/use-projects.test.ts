import { describe, expect, it } from "vitest"
import type { Project } from "@yodea/contracts/project"
import type { YodeaBridge } from "@yodea/desktop/preload/api"
import {
  createProject,
  startProjects,
  type ProjectsState
} from "@yodea/desktop/renderer/use-projects"

// A controllable stub of window.yodea. listProjects/createProject resolve or
// reject on demand; onProjectsChanged hands back a push() so a test can simulate
// a main-process push and assert it reaches state.
const makeBridge = () => {
  let listResolve!: (ps: ReadonlyArray<Project>) => void
  let listReject!: (cause: unknown) => void
  const listPromise = new Promise<ReadonlyArray<Project>>((res, rej) => {
    listResolve = res
    listReject = rej
  })
  let createImpl: (name: string) => Promise<Project> = (name) =>
    Promise.resolve({ id: `id-${name}`, name, createdAt: "t" })
  let push: ((ps: ReadonlyArray<Project>) => void) | undefined
  let unsubscribed = false

  const bridge: YodeaBridge = {
    listProjects: () => listPromise,
    createProject: (name) => createImpl(name),
    onProjectsChanged: (cb) => {
      push = cb
      return () => {
        unsubscribed = true
      }
    }
  }
  return {
    bridge,
    listResolve,
    listReject,
    pushChange: (ps: ReadonlyArray<Project>) => push?.(ps),
    setCreate: (impl: (name: string) => Promise<Project>) => {
      createImpl = impl
    },
    wasUnsubscribed: () => unsubscribed
  }
}

const makeState = () => {
  const calls: { projects: Array<ReadonlyArray<Project>>; errors: Array<string | null> } = {
    projects: [],
    errors: []
  }
  const state: ProjectsState = {
    setProjects: (ps) => calls.projects.push(ps),
    setError: (e) => calls.errors.push(e)
  }
  return { state, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("renderer use-projects bridge", () => {
  it("seeds state from listProjects() and reflects later pushes", async () => {
    const h = makeBridge()
    const { state, calls } = makeState()
    const stop = startProjects(h.bridge, state)

    h.listResolve([{ id: "a", name: "alpha", createdAt: "t" }])
    await tick()
    expect(calls.projects.at(-1)?.map((p) => p.name)).toEqual(["alpha"])

    h.pushChange([
      { id: "a", name: "alpha", createdAt: "t" },
      { id: "b", name: "beta", createdAt: "t" }
    ])
    expect(calls.projects.at(-1)?.map((p) => p.name)).toEqual(["alpha", "beta"])

    stop()
    expect(h.wasUnsubscribed()).toBe(true)
  })

  it("does not clobber a push that arrives before the seed resolves", async () => {
    const h = makeBridge()
    const { state, calls } = makeState()
    startProjects(h.bridge, state)

    // Push arrives first (fresh, newer list)...
    h.pushChange([{ id: "x", name: "live", createdAt: "t" }])
    expect(calls.projects.at(-1)?.map((p) => p.name)).toEqual(["live"])

    // ...then the in-flight (staler) seed resolves and must be dropped.
    h.listResolve([])
    await tick()
    expect(calls.projects.at(-1)?.map((p) => p.name)).toEqual(["live"])
  })

  it("surfaces an error (not an unhandled rejection) when listProjects rejects", async () => {
    const h = makeBridge()
    const { state, calls } = makeState()
    startProjects(h.bridge, state)

    h.listReject(new Error("backend down"))
    await tick()
    expect(calls.projects).toEqual([])
    expect(calls.errors.at(-1)).toContain("backend down")
  })

  it("ignores a push after stop()", async () => {
    const h = makeBridge()
    const { state, calls } = makeState()
    const stop = startProjects(h.bridge, state)
    stop()
    h.pushChange([{ id: "x", name: "late", createdAt: "t" }])
    expect(calls.projects).toEqual([])
  })

  it("createProject resolves true and clears any error on success", async () => {
    const h = makeBridge()
    const { state, calls } = makeState()
    const ok = await createProject(h.bridge, "omega", state)
    expect(ok).toBe(true)
    expect(calls.errors.at(-1)).toBeNull()
  })

  it("createProject resolves false and sets an error on rejection", async () => {
    const h = makeBridge()
    h.setCreate(() => Promise.reject(new Error("spawn failed")))
    const { state, calls } = makeState()
    const ok = await createProject(h.bridge, "omega", state)
    expect(ok).toBe(false)
    expect(calls.errors.at(-1)).toContain("spawn failed")
  })
})
