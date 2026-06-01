import { afterEach, describe, expect, it } from "vitest"
import { Text } from "ink"
import { render, cleanup } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import { RuntimeContext } from "@yodea/tui/runtime"
import { useProjects } from "@yodea/tui/hooks/use-projects"

const flush = () => new Promise((r) => setTimeout(r, 50))

// A probe that renders the status string so we can assert on lastFrame().
const Probe = () => {
  const s = useProjects()
  return <Text>{s.status === "ready" ? `ready:${s.projects.length}` : s.status}</Text>
}

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, createdAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
    },
  })

afterEach(() => cleanup())

describe("useProjects bridge", () => {
  it("goes loading -> ready and reflects live SubscriptionRef changes", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}>
          <Probe />
        </RuntimeContext.Provider>
      )
      await flush()
      expect(lastFrame()).toContain("ready:0")
      await Effect.runPromise(SubscriptionRef.update(ref, () => [{ id: "x", name: "live", createdAt: "t" }]))
      await flush()
      expect(lastFrame()).toContain("ready:1")
    } finally {
      await runtime.dispose()
    }
  })

  it("surfaces an error status when the store layer fails to build", async () => {
    const failing = Layer.effect(ProjectStore, Effect.die(new Error("backend unavailable")))
    const runtime = ManagedRuntime.make(failing)
    try {
      const { lastFrame } = render(
        <RuntimeContext.Provider value={runtime as any}>
          <Probe />
        </RuntimeContext.Provider>
      )
      await flush()
      expect(lastFrame()).toContain("error")
    } finally {
      await runtime.dispose()
    }
  })
})
