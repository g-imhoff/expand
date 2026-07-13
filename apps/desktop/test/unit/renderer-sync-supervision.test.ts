import { afterEach, describe, expect, it, vi } from "vitest"
import { Cause, Effect, Exit } from "effect"

const syncFailure = vi.hoisted(() => new Error("renderer status stream failed"))

vi.mock("@expand/electron-ipc/renderer", async () => {
  const { Effect } = await import("effect")
  return {
    makeIpcClient: () => ({ rpcPort: Effect.succeed({}) })
  }
})

vi.mock("@expand/desktop/renderer/rpc/project-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@expand/desktop/renderer/rpc/project-rpc")>()
  const { Effect, Layer, Stream } = await import("effect")
  const status = Stream.make("connected").pipe(
    Stream.concat(
      Stream.fromEffect(
        Effect.sleep("50 millis").pipe(Effect.andThen(Effect.fail(syncFailure)))
      )
    )
  )
  return {
    ...actual,
    ProjectRpcLayer: Layer.succeed(actual.ProjectRpc, {
      status,
      list: () => Effect.succeed({ projects: [], seq: 0 }),
      events: () => Stream.never
    } as never)
  }
})

vi.mock("@expand/desktop/renderer/rpc/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@expand/desktop/renderer/rpc/transport")>()
  const { Effect } = await import("effect")
  return {
    ...actual,
    buildRendererClient: () => Effect.succeed({})
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("renderer project synchronization supervision", () => {
  it("propagates synchronization failure after mounting", async () => {
    vi.stubGlobal("window", { expand: {} })
    const { boot } = await import("@expand/desktop/renderer/app/runtime")
    const mount = vi.fn()
    const exit = await Effect.runPromiseExit(
      boot(mount).pipe(Effect.timeout("500 millis"))
    )
    expect(mount).toHaveBeenCalledTimes(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(Cause.squash(exit.cause))).toContain(syncFailure.message)
    }
  })
})
