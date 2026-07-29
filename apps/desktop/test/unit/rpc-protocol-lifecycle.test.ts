import { it } from "@effect/vitest"
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
  SubscriptionRef
} from "effect"
import { describe, expect } from "vitest"
import {
  ClientSession,
  type ClientSessionApi,
  type ConnectionStatus
} from "@expand/client-ts"
import {
  ProjectClient,
  type ProjectClientApi
} from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { runRpcServer } from "@expand/desktop/main/rpc/server"
import { buildRendererClient } from "@expand/desktop/renderer/rpc/transport"

type MessageListener = (event: { data: unknown }) => void

const makeMainLayer = Effect.fn("DesktopRpcLifecycleTest.makeMainLayer")(function* (
  providedStatus?: SubscriptionRef.SubscriptionRef<ConnectionStatus>
) {
  const status = providedStatus ?? (yield* SubscriptionRef.make<ConnectionStatus>("connected"))
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  const project: ProjectClientApi = {
    create: () => Effect.die("unused"),
    rename: () => Effect.die("unused"),
    changeDirectory: () => Effect.die("unused"),
    archive: () => Effect.die("unused"),
    restore: () => Effect.die("unused"),
    setMetadata: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    list: () => Effect.succeed({ projects: [], seq: 0 }),
    events: () => Stream.die("unused")
  }
  return Layer.mergeAll(
    Layer.succeed(ClientSession, session),
    Layer.succeed(ProjectClient, project),
    Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
  )
})

const makeMainPort = (
  started: Queue.Queue<void>,
  options?: {
    readonly postMessage?: ((message: unknown) => void) | undefined
    readonly startDefect?: Error | undefined
  }
) => {
  const attached: Array<MessageListener> = []
  const detached: Array<MessageListener> = []
  const closeAttached: Array<() => void> = []
  const closeDetached: Array<() => void> = []
  let active: MessageListener | null = null
  let retained: MessageListener | null = null
  let activeClose: (() => void) | null = null
  let starts = 0
  let closes = 0
  const port = {
    postMessage: (message: unknown) => { options?.postMessage?.(message) },
    on: (event: "message" | "close", listener: MessageListener | (() => void)) => {
      if (event === "close") {
        closeAttached.push(listener as () => void)
        activeClose = listener as () => void
      } else {
        attached.push(listener as MessageListener)
        active = listener as MessageListener
        retained = listener as MessageListener
      }
    },
    off: (event: "message" | "close", listener: MessageListener | (() => void)) => {
      if (event === "close") {
        closeDetached.push(listener as () => void)
        if (activeClose === listener) activeClose = null
      } else {
        detached.push(listener as MessageListener)
        if (active === listener) active = null
      }
    },
    start: () => {
      starts += 1
      Queue.offerUnsafe(started, undefined)
      if (options?.startDefect !== undefined) throw options.startDefect
    },
    close: () => { closes += 1 }
  }
  return {
    port,
    attached,
    detached,
    closeAttached,
    closeDetached,
    active: () => active,
    activeClose: () => activeClose,
    fireClose: () => { activeClose?.() },
    retained: () => retained,
    starts: () => starts,
    closes: () => closes
  }
}

const makeRendererPort = (
  started: Queue.Queue<void>,
  options?: {
    readonly postMessage?: ((message: unknown) => void) | undefined
    readonly startDefect?: Error | undefined
  }
) => {
  let handler: MessageListener | null = null
  let owned: MessageListener | null = null
  let starts = 0
  let closes = 0
  const port = {
    postMessage: (message: unknown) => { options?.postMessage?.(message) },
    get onmessage() {
      return handler
    },
    set onmessage(listener: MessageListener | null) {
      handler = listener
      if (listener !== null && owned === null) owned = listener
    },
    start: () => {
      starts += 1
      Queue.offerUnsafe(started, undefined)
      if (options?.startDefect !== undefined) throw options.startDefect
    },
    close: () => { closes += 1 }
  }
  return {
    port,
    handler: () => handler,
    owned: () => owned,
    replace: (replacement: MessageListener) => { handler = replacement },
    starts: () => starts,
    closes: () => closes
  }
}

describe("desktop RPC port protocol lifecycle", () => {
  it.effect("Connect interrupts cleanly when the server owner stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mainStarted = yield* Queue.unbounded<void>()
        const rendererStarted = yield* Queue.unbounded<void>()
        const mainMessages = yield* Queue.unbounded<unknown>()
        const rendererMessages = yield* Queue.unbounded<unknown>()
        const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
        const mainLayer = yield* makeMainLayer(status)
        let renderer: ReturnType<typeof makeRendererPort>
        const main = makeMainPort(mainStarted, {
          postMessage: (message) => {
            Queue.offerUnsafe(rendererMessages, structuredClone(message))
          }
        })
        renderer = makeRendererPort(rendererStarted, {
          postMessage: (message) => {
            Queue.offerUnsafe(mainMessages, structuredClone(message))
          }
        })
        yield* Effect.forever(
          Queue.take(mainMessages).pipe(
            Effect.tap((data) => Effect.sync(() => main.active()?.({ data })))
          )
        ).pipe(Effect.forkScoped)
        yield* Effect.forever(
          Queue.take(rendererMessages).pipe(
            Effect.tap((data) => Effect.sync(() => renderer.handler()?.({ data })))
          )
        ).pipe(Effect.forkScoped)
        const serverFiber = yield* runRpcServer(main.port).pipe(
          Effect.provide(mainLayer),
          Effect.scoped,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Queue.take(mainStarted)
        const rendererScope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(rendererScope, Exit.void))
        const client = yield* buildRendererClient(renderer.port).pipe(
          Scope.provide(rendererScope)
        )
        yield* Queue.take(rendererStarted)
        const values = yield* Queue.unbounded<boolean>()
        const connectFiber = yield* client.Connect().pipe(
          Stream.runForEach((value) => Queue.offer(values, value)),
          Effect.forkChild({ startImmediately: true })
        )

        expect(yield* Queue.take(values)).toBe(true)
        yield* SubscriptionRef.set(status, "reconnecting")
        expect(yield* Queue.take(values)).toBe(false)
        expect(yield* client.ProjectList({ includeArchived: true })).toEqual({ projects: [], seq: 0 })
        yield* Fiber.interrupt(serverFiber)

        const connectExit = yield* Fiber.join(connectFiber).pipe(Effect.exit)
        const renderedCause = Exit.isFailure(connectExit)
          ? Cause.pretty(connectExit.cause)
          : ""
        expect(renderedCause).not.toContain("Expected never")
        expect(renderedCause).not.toContain("Done")
        expect(Exit.isFailure(connectExit) && Cause.hasInterruptsOnly(connectExit.cause)).toBe(true)
        yield* Scope.close(rendererScope, Exit.void)
      })
    ))

  it.effect("main closes protocol resources when the remote port closes", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const mainLayer = yield* makeMainLayer()
      const scope = yield* Scope.make()
      const fake = makeMainPort(started)
      const fiber = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Scope.provide(scope),
        Effect.forkChild({ startImmediately: true })
      )

      yield* Queue.take(started)
      expect(fake.closeAttached).toHaveLength(1)
      fake.fireClose()
      yield* Effect.yieldNow
      expect(fake.detached).toEqual([fake.attached[0]])
      expect(fake.closeDetached).toEqual([fake.closeAttached[0]])
      expect(fake.active()).toBeNull()
      expect(fake.activeClose()).toBeNull()
      expect(fake.closes()).toBe(1)
      yield* Scope.close(scope, Exit.void)
      yield* Fiber.interrupt(fiber)
    })
  )

  it.effect("main owns one stable listener and closes it with the scope", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const mainLayer = yield* makeMainLayer()
      const scope = yield* Scope.make()
      const fake = makeMainPort(started)
      const fiber = yield* Effect.forkChild(
        runRpcServer(fake.port).pipe(
          Effect.provide(mainLayer),
          Scope.provide(scope)
        ),
        { startImmediately: true }
      )

      yield* Queue.take(started)
      expect(fake.attached).toHaveLength(1)
      expect(fake.closeAttached).toHaveLength(1)
      expect(fake.starts()).toBe(1)
      expect(fake.active()).toBe(fake.attached[0])
      expect(fake.activeClose()).toBe(fake.closeAttached[0])
      expect(fake.closes()).toBe(0)

      yield* Scope.close(scope, Exit.void)
      expect(fake.detached).toEqual([fake.attached[0]])
      expect(fake.closeDetached).toEqual([fake.closeAttached[0]])
      expect(fake.active()).toBeNull()
      expect(fake.activeClose()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(() => fake.retained()?.({ data: "late" })).not.toThrow()
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("renderer owns its handler and closes it with the scope", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const scope = yield* Scope.make()
      const fake = makeRendererPort(started)

      yield* buildRendererClient(fake.port).pipe(Scope.provide(scope))
      yield* Queue.take(started)
      expect(fake.handler()).toBe(fake.owned())
      expect(fake.starts()).toBe(1)
      expect(fake.closes()).toBe(0)

      yield* Scope.close(scope, Exit.void)
      expect(fake.handler()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(() => fake.owned()?.({ data: "late" })).not.toThrow()
    }))

  it.effect("renderer preserves a replacement handler while closing its port", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const scope = yield* Scope.make()
      const fake = makeRendererPort(started)
      const replacement: MessageListener = () => {}

      yield* buildRendererClient(fake.port).pipe(Scope.provide(scope))
      fake.replace(replacement)
      yield* Scope.close(scope, Exit.void)

      expect(fake.handler()).toBe(replacement)
      expect(fake.closes()).toBe(1)
    }))

  it.effect("main releases its listener and port after a start defect", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const mainLayer = yield* makeMainLayer()
      const fake = makeMainPort(started, { startDefect: new Error("main start defect") })

      const exit = yield* runRpcServer(fake.port).pipe(
        Effect.provide(mainLayer),
        Effect.scoped,
        Effect.exit
      )

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(fake.starts()).toBe(1)
      expect(fake.detached).toEqual([fake.attached[0]])
      expect(fake.active()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(() => fake.retained()?.({ data: "late" })).not.toThrow()
    }))

  it.effect("renderer releases its handler and port after a start defect", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<void>()
      const fake = makeRendererPort(started, { startDefect: new Error("renderer start defect") })

      const exit = yield* buildRendererClient(fake.port).pipe(
        Effect.scoped,
        Effect.exit
      )

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(fake.starts()).toBe(1)
      expect(fake.handler()).toBeNull()
      expect(fake.closes()).toBe(1)
      expect(() => fake.owned()?.({ data: "late" })).not.toThrow()
    }))
})
