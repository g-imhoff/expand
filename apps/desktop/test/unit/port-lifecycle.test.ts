import { it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, FiberSet, Ref, Scope } from "effect"
import { describe, expect } from "vitest"
import { wirePortLifecycle } from "@expand/desktop/main/ipc/port-lifecycle"
import type { MainPortLike } from "@expand/desktop/main/rpc/server"

const waitFor = Deferred.await

type NavigationListener = (details: { readonly isSameDocument: boolean }) => void

const sender = { frameUrl: "file:///app/index.html" }

const makeEndpoint = (name: string, events: Array<string>) => {
  let closes = 0
  return {
    name,
    postMessage: (_message: unknown) => {},
    on: (_event: "message", _listener: (event: { data: unknown }) => void) => {},
    off: (_event: "message", _listener: (event: { data: unknown }) => void) => {},
    start: () => {},
    close: () => {
      closes += 1
      events.push(`close:${name}`)
    },
    closes: () => closes
  }
}

const makeHarness = Effect.fn("DesktopPortLifecycleTest.makeHarness")(function* (
  connect: (port: MainPortLike) => Effect.Effect<void, never, Scope.Scope>
) {
  const events: Array<string> = []
  const channels: Array<{
    port1: ReturnType<typeof makeEndpoint>
    port2: ReturnType<typeof makeEndpoint>
  }> = []
  let navigation: NavigationListener | undefined
  let closed: (() => void) | undefined
  let navigationDisposals = 0
  let closedDisposals = 0
  const windowScope = yield* Scope.make()
  const callbacks = yield* FiberSet.make()
  const dispatchEffect = yield* FiberSet.runtime(callbacks)<never>()
  const lifecycle = yield* wirePortLifecycle({
    onNavigation: (listener) => {
      navigation = listener
      return () => {
        navigationDisposals += 1
        if (navigation === listener) navigation = undefined
      }
    },
    onClosed: (listener) => {
      closed = listener
      return () => {
        closedDisposals += 1
        if (closed === listener) closed = undefined
      }
    },
    makeMessageChannel: () => {
      const index = channels.length + 1
      const channel = {
        port1: makeEndpoint(`main-${index}`, events),
        port2: makeEndpoint(`renderer-${index}`, events)
      }
      channels.push(channel)
      return channel
    },
    connectPort: connect,
    closeWindow: Scope.close(windowScope, Exit.void),
    dispatch: (effect) => { dispatchEffect(effect) }
  }).pipe(Scope.provide(windowScope))
  return {
    lifecycle,
    events,
    channels,
    windowScope,
    navigate: (isSameDocument: boolean) => navigation?.({ isSameDocument }),
    closeWindow: () => { closed?.() },
    navigationDisposals: () => navigationDisposals,
    closedDisposals: () => closedDisposals
  }
})

describe("wirePortLifecycle", () => {
  it.effect("serializes overlapping grants in request order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(() => Effect.void)
        const firstGrant = yield* Deferred.make<void>()
        const releaseFirst = yield* Deferred.make<void>()
        const grants = yield* Ref.make<ReadonlyArray<string>>([])
        const requestA = yield* harness.lifecycle.rpcPort(sender, (port) =>
          Ref.update(grants, (values) => [...values, port.name]).pipe(
            Effect.andThen(Deferred.succeed(firstGrant, undefined)),
            Effect.andThen(waitFor(releaseFirst))
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* waitFor(firstGrant)
        const requestB = yield* harness.lifecycle.rpcPort(sender, (port) =>
          Ref.update(grants, (values) => [...values, port.name])
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(yield* Ref.get(grants)).toEqual(["renderer-1"])
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(requestA)
        yield* Fiber.join(requestB)
        expect(yield* Ref.get(grants)).toEqual(["renderer-1", "renderer-2"])
      })
    ))

  it.effect("waits for the previous port finalizer before a later grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closing = yield* Deferred.make<void>()
        const releaseClose = yield* Deferred.make<void>()
        let connected = 0
        const harness = yield* makeHarness(() =>
          Effect.gen(function* () {
            connected += 1
            if (connected === 1) {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(closing, undefined).pipe(Effect.andThen(waitFor(releaseClose)))
              )
            }
          })
        )
        yield* harness.lifecycle.rpcPort(sender, () => Effect.void)
        const granted = yield* Deferred.make<void>()
        const second = yield* harness.lifecycle.rpcPort(sender, () => Deferred.succeed(granted, undefined)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* waitFor(closing)
        expect(yield* Deferred.isDone(granted)).toBe(false)
        yield* Deferred.succeed(releaseClose, undefined)
        yield* Fiber.join(second)
        expect(yield* Deferred.isDone(granted)).toBe(true)
      })
    ))

  it.effect("rolls back both main-owned endpoints after transfer failure and accepts a later request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness((port) =>
          Effect.addFinalizer(() => Effect.sync(() => port.close?.()))
        )
        const failed = yield* harness.lifecycle.rpcPort(sender, () => Effect.die(new Error("transfer failed"))).pipe(
          Effect.exit
        )
        expect(Exit.isFailure(failed)).toBe(true)
        expect(harness.channels[0]?.port1.closes()).toBe(1)
        expect(harness.channels[0]?.port2.closes()).toBe(1)
        const granted = yield* Deferred.make<void>()
        yield* harness.lifecycle.rpcPort(sender, () => Deferred.succeed(granted, undefined))
        expect(yield* Deferred.isDone(granted)).toBe(true)
        expect(harness.channels[1]?.port2.closes()).toBe(0)
      })
    ))

  it.effect("ignores same-document navigation and fully closes before a post-navigation grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closing = yield* Deferred.make<void>()
        const releaseClose = yield* Deferred.make<void>()
        let connected = 0
        const harness = yield* makeHarness(() =>
          Effect.gen(function* () {
            connected += 1
            if (connected === 1) {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(closing, undefined).pipe(Effect.andThen(waitFor(releaseClose)))
              )
            }
          })
        )
        yield* harness.lifecycle.rpcPort(sender, () => Effect.void)
        harness.navigate(true)
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(closing)).toBe(false)
        harness.navigate(false)
        yield* waitFor(closing)
        const granted = yield* Deferred.make<void>()
        const later = yield* harness.lifecycle.rpcPort(sender, () => Deferred.succeed(granted, undefined)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(granted)).toBe(false)
        yield* Deferred.succeed(releaseClose, undefined)
        yield* Fiber.join(later)
        expect(yield* Deferred.isDone(granted)).toBe(true)
      })
    ))

  it.effect("closes the window child scope and exact listeners once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>()
        const harness = yield* makeHarness(() => Effect.void)
        yield* Scope.addFinalizer(harness.windowScope, Deferred.succeed(released, undefined))
        harness.closeWindow()
        yield* waitFor(released)
        expect(harness.navigationDisposals()).toBe(1)
        expect(harness.closedDisposals()).toBe(1)
        yield* Scope.close(harness.windowScope, Exit.void)
        expect(harness.navigationDisposals()).toBe(1)
        expect(harness.closedDisposals()).toBe(1)
      })
    ))
})
