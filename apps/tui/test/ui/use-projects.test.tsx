import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { BackendUnavailable } from "@expand/client-ts"
import { ProjectRenamed } from "@expand/contracts/events/project"
import { useProjects } from "@expand/tui/use-projects"
import {
  fakeProject,
  makeRuntimeHarness,
  renderWithRuntime,
  type RuntimeHarness
} from "./_runtime-harness"

const alpha = fakeProject(1, "alpha")
const beta = fakeProject(2, "beta")

const renderHookWithRuntime = (harness: RuntimeHarness) => {
  let observed: ReturnType<typeof useProjects> | undefined
  const Probe = () => {
    observed = useProjects()
    return null
  }
  const rendered = renderWithRuntime(<Probe />, harness)
  const result = () => {
    if (!observed) throw new Error("hook was not observed")
    return observed
  }
  return {
    ...rendered,
    result,
    projects: () => result().projects.map((project) => project.name),
    snapshot: () => result().snapshot,
    waitForProjects: (names: ReadonlyArray<string>) =>
      vi.waitFor(() => expect(result().projects.map((project) => project.name)).toEqual(names))
  }
}

describe("useProjects", () => {
  it("publishes the initial synchronized snapshot", async () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    try {
      const view = renderHookWithRuntime(harness)
      await view.waitForProjects(["alpha"])
      expect(view.snapshot()).toEqual({ projects: [alpha], seq: 1 })
    } finally {
      await harness.dispose()
    }
  })

  it("folds live events into React-owned state", async () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    try {
      const view = renderHookWithRuntime(harness)
      await view.waitForProjects(["alpha"])
      harness.events.publish(ProjectRenamed.make({
        projectId: alpha.id,
        name: "alpha-live",
        occurredAt: "t2"
      }))
      await view.waitForProjects(["alpha-live"])
      expect(view.snapshot().seq).toBe(2)
    } finally {
      await harness.dispose()
    }
  })

  it("retains projects while reconnecting and replaces after resnapshot", async () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    try {
      const view = renderHookWithRuntime(harness)
      await view.waitForProjects(["alpha"])
      harness.status.set("reconnecting")
      harness.authoritative.set({ projects: [beta], seq: 5 })
      expect(view.projects()).toEqual(["alpha"])
      harness.status.set("connected")
      await view.waitForProjects(["beta"])
      expect(view.snapshot().seq).toBe(5)
    } finally {
      await harness.dispose()
    }
  })

  it("interrupts synchronization on unmount", async () => {
    const harness = makeRuntimeHarness({ snapshot: { projects: [alpha], seq: 1 } })
    try {
      const view = renderHookWithRuntime(harness)
      view.unmount()
      expect(await harness.syncInterrupted()).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it("surfaces an initial runtime build failure", async () => {
    const harness = makeRuntimeHarness({
      failure: new BackendUnavailable({ reason: "offline" })
    })
    try {
      const view = renderHookWithRuntime(harness)
      await vi.waitFor(() => expect(view.result().error).toBe("backend unavailable: offline"))
    } finally {
      await harness.dispose()
    }
  })

  it("calls ProjectClient with ensure create semantics without using the response as state", async () => {
    const harness = makeRuntimeHarness({
      snapshot: { projects: [alpha], seq: 1 },
      client: {
        create: () => Effect.succeed({ created: true, project: beta })
      }
    })
    try {
      const view = renderHookWithRuntime(harness)
      await view.waitForProjects(["alpha"])
      view.result().create("beta")
      await vi.waitFor(() => expect(harness.calls.create).toEqual([{ name: "beta", ensure: true }]))
      expect(view.projects()).toEqual(["alpha"])
    } finally {
      await harness.dispose()
    }
  })
})
