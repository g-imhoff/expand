import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import { registerIpc } from "@yodea/desktop/main/ipc"

const fakeLayer = (ref: SubscriptionRef.SubscriptionRef<ReadonlyArray<any>>) =>
  Layer.succeed(ProjectStore, {
    projects: ref,
    events: Stream.empty,
    createProject: (name: string) => {
      const project = { id: `id-${name}`, name, createdAt: "t" }
      return SubscriptionRef.update(ref, (cur) => [...cur, project]).pipe(Effect.as(project))
    }
  })

describe("registerIpc", () => {
  it("wires list/create handlers and pushes changes to the renderer", async () => {
    const ref = await Effect.runPromise(SubscriptionRef.make<ReadonlyArray<any>>([]))
    const runtime = ManagedRuntime.make(fakeLayer(ref))
    const handlers = new Map<string, (...a: any[]) => Promise<unknown>>()
    const sent: Array<{ channel: string; payload: unknown }> = []
    try {
      registerIpc({
        handle: (channel, fn) => handlers.set(channel, fn),
        runtime,
        send: (channel, payload) => sent.push({ channel, payload })
      })
      // create via the registered handler
      const created = await handlers.get("project:create")!({}, "omega")
      expect((created as any).name).toBe("omega")
      // list reflects it
      const list = await handlers.get("project:list")!()
      expect((list as Array<any>).map((p) => p.name)).toContain("omega")
      // a change was pushed to the renderer
      await new Promise((r) => setTimeout(r, 30))
      const pushed = sent.filter((s) => s.channel === "project:changed").at(-1)
      expect((pushed?.payload as Array<any>).map((p) => p.name)).toContain("omega")
    } finally {
      await runtime.dispose()
    }
  })
})
