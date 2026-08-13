import { it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { describe, expect } from "vitest"
import { acquireRpcPort } from "@expand/desktop/renderer/app/runtime"

const waitForDeferred = Deferred.await

interface MessageEventLike {
  readonly data: unknown
  readonly source: unknown
  readonly ports: ReadonlyArray<MessagePort>
}

interface FakeWindow {
  readonly expand: { rpcPort: (nonce: string) => void }
  readonly addEventListener: (type: "message", listener: (event: MessageEventLike) => void) => void
  readonly removeEventListener: (type: "message", listener: (event: MessageEventLike) => void) => void
  readonly fire: (event: MessageEventLike) => void
}

class FakeMessagePort implements MessagePort {
  onmessage: ((this: MessagePort, ev: MessageEvent) => unknown) | null = null
  onmessageerror: ((this: MessagePort, ev: MessageEvent) => unknown) | null = null

  close(): void {}

  postMessage(message: unknown, transfer: Transferable[]): void
  postMessage(message: unknown, options?: StructuredSerializeOptions): void
  postMessage(_message: unknown, _transferOrOptions?: Transferable[] | StructuredSerializeOptions): void {}

  start(): void {}

  addEventListener<K extends keyof MessagePortEventMap>(
    type: K,
    listener: (this: MessagePort, ev: MessagePortEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions
  ): void
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void
  addEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | ((this: MessagePort, ev: MessageEvent) => unknown),
    _options?: boolean | AddEventListenerOptions
  ): void {}

  removeEventListener<K extends keyof MessagePortEventMap>(
    type: K,
    listener: (this: MessagePort, ev: MessagePortEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ): void
  removeEventListener(
    _type: string,
    _listener: EventListenerOrEventListenerObject | ((this: MessagePort, ev: MessageEvent) => unknown),
    _options?: boolean | EventListenerOptions
  ): void {}

  dispatchEvent(_event: Event): boolean {
    return true
  }
}

const makeFakeWindow = (): FakeWindow => {
  const listeners = new Set<(event: MessageEventLike) => void>()
  return {
    expand: { rpcPort: () => {} },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    fire: (event) => {
      for (const listener of listeners) listener(event)
    }
  }
}

const installWindow = (value: FakeWindow): (() => void) => {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  Object.defineProperty(globals, "window", { configurable: true, value })
  return () => {
    if (previous === undefined) delete globals.window
    else Object.defineProperty(globals, "window", { configurable: true, value: previous })
  }
}

describe("acquireRpcPort", () => {
  it.effect("requests through the supplied bridge and returns the granted port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const win = makeFakeWindow()
        const restoreWindow = installWindow(win)
        yield* Effect.addFinalizer(() => Effect.sync(restoreWindow))
        const requested = yield* Deferred.make<string>()
        win.expand.rpcPort = (nonce: string) => {
          Deferred.doneUnsafe(requested, Effect.succeed(nonce))
        }
        const port = yield* Effect.acquireRelease(
          Effect.sync(() => new FakeMessagePort()),
          (owned) => Effect.sync(() => owned.close())
        )
        const fiber = yield* Effect.forkChild(
          acquireRpcPort()
        )
        const nonce = yield* waitForDeferred(requested)
        expect(nonce).toMatch(/^[0-9a-f]{32}$/)
        win.fire({
          data: { _tag: "IpcPortGrant", channel: "expand:rpcPort", nonce },
          source: win,
          ports: [port]
        })
        const exit = yield* Effect.exit(Fiber.join(fiber))
        expect(exit).toEqual(Exit.succeed(port))
      })
    ))
})
