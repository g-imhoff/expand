import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "ink-testing-library"
import { Effect, Layer, ManagedRuntime, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import { RuntimeContext } from "@yodea/tui/runtime"
import { App } from "@yodea/tui/components/app"

const flush = () => new Promise((r) => setTimeout(r, 50))
afterEach(() => cleanup())

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, createdAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
    },
  })

const mount = (runtime: ManagedRuntime.ManagedRuntime<any, never>) =>
  render(
    <RuntimeContext.Provider value={runtime as any}>
      <App />
    </RuntimeContext.Provider>
  )

describe("App", () => {
  it("renders the project list and creates a project via /new", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = mount(runtime)
      await flush()
      expect(lastFrame()).toContain("Projects (0)")
      stdin.write("/new alpha")
      await flush()
      stdin.write("\r")
      await flush()
      expect(lastFrame()).toContain("alpha")
      expect(lastFrame()).toContain("Projects (1)")
    } finally {
      await runtime.dispose()
    }
  })

  it("/open switches to the workspace region", async () => {
    const ref = await Effect.runPromise(
      SubscriptionRef.make<ReadonlyArray<any>>([{ id: "p1", name: "alpha", createdAt: "t" }])
    )
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = mount(runtime)
      await flush()
      stdin.write("/open alpha")
      await flush()
      stdin.write("\r")
      await flush()
      expect(lastFrame()).toContain("project: alpha")
      expect(lastFrame()).toContain("coming soon")
    } finally {
      await runtime.dispose()
    }
  })

  it("reports an unknown command inline instead of crashing", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    try {
      const { stdin, lastFrame } = mount(runtime)
      await flush()
      stdin.write("/bogus")
      await flush()
      stdin.write("\r")
      await flush()
      expect(lastFrame()).toContain("Unknown command")
    } finally {
      await runtime.dispose()
    }
  })

  it("shows the ErrorView when the store fails to build", async () => {
    const runtime = ManagedRuntime.make(Layer.effect(ProjectStore, Effect.die(new Error("backend unavailable"))))
    try {
      const { lastFrame } = mount(runtime)
      await flush()
      expect(lastFrame()).toContain("Something went wrong")
      expect(lastFrame()).toContain("backend unavailable")
    } finally {
      await runtime.dispose()
    }
  })
})
