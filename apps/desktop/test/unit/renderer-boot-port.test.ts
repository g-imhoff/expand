// apps/desktop/test/unit/renderer-boot-port.test.ts
import { describe, expect, it } from "vitest"
import { Effect, Exit, Fiber } from "effect"
import { acquireRpcPort } from "@expand/desktop/renderer/app/runtime"
import type { MessageEventLike, RendererWindowLike } from "@expand/electron-ipc/renderer"

interface FakeWindow extends RendererWindowLike {
  fire: (event: MessageEventLike) => void
}

const makeFakeWindow = (): FakeWindow => {
  const listeners = new Set<(event: MessageEventLike) => void>()
  return {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    fire: (event) => listeners.forEach((listener) => listener(event))
  }
}

describe("acquireRpcPort", () => {
  it("requests via the bridge and resolves with the granted port", async () => {
    const win = makeFakeWindow()
    const requests: Array<string> = []
    const bridge = { rpcPort: (nonce: string) => requests.push(nonce) }
    const fakePort = { fake: "port" } as unknown as MessagePort

    const fiber = Effect.runFork(
      acquireRpcPort({ bridge: () => bridge, win, nonce: () => "n-1", timeoutMillis: 200 })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(requests).toEqual(["n-1"])
    win.fire({
      data: { _tag: "IpcPortGrant", channel: "expand:rpcPort", nonce: "n-1" },
      source: win,
      ports: [fakePort]
    })
    const exit = await Effect.runPromiseExit(Fiber.join(fiber))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(fakePort)
  })
})
