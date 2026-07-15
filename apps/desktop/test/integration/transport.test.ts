import { it } from "@effect/vitest"
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Queue, Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect } from "vitest"
import { ClientSession, type ClientSessionApi, type ConnectionStatus } from "@expand/client-ts"
import { ProjectClient, type ProjectClientApi } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { connectPort } from "@expand/desktop/main/rpc/transport"

const waitFor = Deferred.await

const makeSession = Effect.fn("DesktopTransportTest.makeSession")(function* () {
  const status = yield* SubscriptionRef.make<ConnectionStatus>("connected")
  const session: ClientSessionApi = {
    status,
    current: Effect.die("unused"),
    epochs: Stream.empty
  }
  return session
})

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

const makeRuntime = Effect.fn("DesktopTransportTest.makeRuntime")(function* (
  acquisitionStarted: Deferred.Deferred<void>,
  releaseAcquisition: Deferred.Deferred<ClientSessionApi>
) {
  const layer = Layer.mergeAll(
    Layer.effect(
      ClientSession,
      Deferred.succeed(acquisitionStarted, undefined).pipe(Effect.andThen(waitFor(releaseAcquisition)))
    ),
    Layer.succeed(ProjectClient, project),
    Layer.succeed(ServerClient, { health: () => Effect.die("unused") })
  )
  const runtime = ManagedRuntime.make(layer)
  yield* Effect.addFinalizer(() => runtime.disposeEffect)
  return runtime
})

const makePort = (started: Queue.Queue<void>, closed?: Deferred.Deferred<void>) => {
  type Listener = (event: { data: unknown }) => void
  let listener: Listener | undefined
  let closes = 0
  return {
    port: {
      postMessage: (_message: unknown) => {},
      on: (_event: "message", callback: Listener) => { listener = callback },
      off: (_event: "message", callback: Listener) => {
        if (listener === callback) listener = undefined
      },
      start: () => { Queue.offerUnsafe(started, undefined) },
      close: () => {
        closes += 1
        if (closed !== undefined) Deferred.doneUnsafe(closed, Effect.void)
      }
    },
    hasListener: () => listener !== undefined,
    closes: () => closes
  }
}

describe("connectPort", () => {
  it.effect("returns after forking while runtime context remains lazy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const acquisitionStarted = yield* Deferred.make<void>()
        const releaseAcquisition = yield* Deferred.make<ClientSessionApi>()
        const runtime = yield* makeRuntime(acquisitionStarted, releaseAcquisition)
        const started = yield* Queue.unbounded<void>()
        const fake = makePort(started)
        const portScope = yield* Scope.make()
        yield* connectPort({ port: fake.port, runtime }).pipe(Scope.provide(portScope))
        yield* waitFor(acquisitionStarted)
        expect(fake.hasListener()).toBe(false)
        expect(fake.closes()).toBe(0)
        yield* Deferred.succeed(releaseAcquisition, yield* makeSession())
        yield* Queue.take(started)
        expect(fake.hasListener()).toBe(true)
        yield* Scope.close(portScope, Exit.void)
        expect(fake.hasListener()).toBe(false)
        expect(fake.closes()).toBe(1)
      })
    ))

  it.effect("closes the main endpoint once when its scope interrupts pending context acquisition", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const acquisitionStarted = yield* Deferred.make<void>()
        const releaseAcquisition = yield* Deferred.make<ClientSessionApi>()
        const runtime = yield* makeRuntime(acquisitionStarted, releaseAcquisition)
        const started = yield* Queue.unbounded<void>()
        const fake = makePort(started)
        const portScope = yield* Scope.make()
        yield* connectPort({ port: fake.port, runtime }).pipe(Scope.provide(portScope))
        yield* waitFor(acquisitionStarted)
        yield* Scope.close(portScope, Exit.void)
        expect(fake.closes()).toBe(1)
        expect(fake.hasListener()).toBe(false)
      })
    ))

  it.effect("closes the main endpoint once when runtime context acquisition fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const acquisitionStarted = yield* Deferred.make<void>()
        const releaseFailure = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const runtime = {
          contextEffect: Deferred.succeed(acquisitionStarted, undefined).pipe(
            Effect.andThen(waitFor(releaseFailure)),
            Effect.andThen(Effect.fail("context failed"))
          )
        }
        const started = yield* Queue.unbounded<void>()
        const fake = makePort(started, closed)
        const portScope = yield* Scope.make()
        yield* connectPort({ port: fake.port, runtime }).pipe(Scope.provide(portScope))
        yield* waitFor(acquisitionStarted)
        expect(fake.closes()).toBe(0)
        yield* Deferred.succeed(releaseFailure, undefined)
        yield* waitFor(closed)
        expect(fake.closes()).toBe(1)
        expect(fake.hasListener()).toBe(false)
        yield* Scope.close(portScope, Exit.void)
        expect(fake.closes()).toBe(1)
      })
    ))
})
