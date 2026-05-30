import { Effect, Fiber, Stream, SubscriptionRef } from "effect"
import { ProjectStore } from "@yodea/client-core"
import type { YodeaRuntime } from "@yodea/desktop/main/runtime"

export interface IpcDeps {
  readonly handle: (channel: string, fn: (...args: Array<any>) => Promise<unknown>) => void
  readonly runtime: YodeaRuntime
  readonly send: (channel: string, payload: unknown) => void
}

// Wires the renderer-facing IPC surface to the Effect ProjectStore and forks a
// consumer that pushes every live list to the renderer. Returns the push fiber.
export const registerIpc = ({ handle, runtime, send }: IpcDeps): Fiber.Fiber<void> => {
  handle("project:list", () =>
    runtime.runPromise(Effect.flatMap(ProjectStore, (s) => SubscriptionRef.get(s.projects))))
  handle("project:create", (_evt: unknown, name: string) =>
    runtime.runPromise(Effect.flatMap(ProjectStore, (s) => s.createProject(name))))
  return runtime.runFork(
    Effect.flatMap(ProjectStore, (s) =>
      Stream.runForEach(SubscriptionRef.changes(s.projects), (ps) =>
        Effect.sync(() => send("project:changed", ps))))
  )
}
