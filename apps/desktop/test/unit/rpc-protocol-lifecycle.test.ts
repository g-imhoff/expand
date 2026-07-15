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

const makeMainLayer = Effect.fn("DesktopRpcLifecycleTest.makeMainLayer")(function* () {
  const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
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
    list: () => Effect.die("unused"),
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
  options?: { readonly startDefect?: Error | undefined }
) => {
  const attached: Array<MessageListener> = []
  const detached: Array<MessageListener> = []
  let active: MessageListener | null = null
  let retained: MessageListener | null = null
  let starts = 0
  let closes = 0
  const port = {
    postMessage: (_message: unknown) => {},
    on: (_event: "message", listener: MessageListener) => {
      attached.push(listener)
      active = listener
      retained = listener
    },
    off: (_event: "message", listener: MessageListener) => {
      detached.push(listener)
      if (active === listener) active = null
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
    active: () => active,
    retained: () => retained,
    starts: () => starts,
    closes: () => closes
  }
}

const makeRendererPort = (
  started: Queue.Queue<void>,
  options?: { readonly startDefect?: Error | undefined }
) => {
  let handler: MessageListener | null = null
  let owned: MessageListener | null = null
  let starts = 0
  let closes = 0
  const port = {
    postMessage: (_message: unknown) => {},
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
      expect(fake.starts()).toBe(1)
      expect(fake.active()).toBe(fake.attached[0])
      expect(fake.closes()).toBe(0)

      yield* Scope.close(scope, Exit.void)
      expect(fake.detached).toEqual([fake.attached[0]])
      expect(fake.active()).toBeNull()
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
