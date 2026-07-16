import { Effect, Exit, Option, Ref, Scope, Semaphore } from "effect"
import type { IpcSenderInfo } from "@expand/electron-ipc/contract"
import type { MainPortLike } from "@expand/desktop/main/rpc/server"

export interface PortEndpoint extends MainPortLike {
  readonly close: () => void
}

export interface RpcPortBroker<Port extends PortEndpoint, R> {
  readonly ownerScope: Scope.Scope
  readonly current: Ref.Ref<Option.Option<Scope.Closeable>>
  readonly semaphore: Semaphore.Semaphore
  readonly makeMessageChannel: () => { readonly port1: Port; readonly port2: Port }
  readonly connectPort: (port: MainPortLike) => Effect.Effect<void, never, R | Scope.Scope>
}

export interface PortLifecycleDeps<Port extends PortEndpoint, R> {
  readonly onNavigation: (
    listener: (details: { readonly isSameDocument: boolean }) => void
  ) => () => void
  readonly onClosed: (listener: () => void) => () => void
  readonly makeMessageChannel: () => { readonly port1: Port; readonly port2: Port }
  readonly connectPort: (port: MainPortLike) => Effect.Effect<void, never, R | Scope.Scope>
  readonly closeWindow: Effect.Effect<void, never, R>
  readonly dispatch: (effect: Effect.Effect<void, never, R>) => void
}

export interface WiredPortLifecycle<Port extends PortEndpoint, R> {
  readonly rpcPort: (
    sender: IpcSenderInfo,
    grant: (port: Port) => Effect.Effect<void>
  ) => Effect.Effect<void, never, R>
  readonly close: Effect.Effect<void, never, R>
}

export const wirePortLifecycle = Effect.fn("DesktopMain.wirePortLifecycle")(function* <
  Port extends PortEndpoint,
  R
>(deps: PortLifecycleDeps<Port, R>) {
  const windowScope = yield* Scope.Scope
  const ownerScope = yield* Scope.fork(windowScope)
  const current = yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none())
  const semaphore = yield* Semaphore.make(1)
  const broker: RpcPortBroker<Port, R> = {
    ownerScope,
    current,
    semaphore,
    makeMessageChannel: deps.makeMessageChannel,
    connectPort: deps.connectPort
  }
  let active = true
  const close = closeRpcPort(broker)
  const navigation = (details: { readonly isSameDocument: boolean }) => {
    if (!active || details.isSameDocument) return
    deps.dispatch(close)
  }
  const closed = () => {
    if (!active) return
    deps.dispatch(deps.closeWindow)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => deps.onNavigation(navigation)),
    (dispose) => Effect.sync(dispose)
  )
  yield* Effect.acquireRelease(
    Effect.sync(() => deps.onClosed(closed)),
    (dispose) => Effect.sync(dispose)
  )
  yield* Effect.addFinalizer(() => close)
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))
  const lifecycle: WiredPortLifecycle<Port, R> = {
    rpcPort: (_sender, grant) => openRpcPort(broker, grant),
    close
  }
  return lifecycle
})

const openRpcPort = Effect.fn("DesktopMain.openRpcPort")(function* <
  Port extends PortEndpoint,
  R
>(
  broker: RpcPortBroker<Port, R>,
  grant: (port: Port) => Effect.Effect<void>
) {
  return yield* broker.semaphore.withPermit(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const previous = yield* Ref.getAndSet(broker.current, Option.none())
        if (Option.isSome(previous)) yield* Scope.close(previous.value, Exit.void)
        const childScope = yield* Scope.fork(broker.ownerScope)
        let mainPort: MainPortLike | undefined
        let rendererPort: Port | undefined
        let transferred = false
        const transaction = Effect.gen(function* () {
          const channel = yield* Effect.sync(broker.makeMessageChannel)
          mainPort = ownMainPort(channel.port1)
          rendererPort = channel.port2
          yield* Ref.set(broker.current, Option.some(childScope))
          yield* broker.connectPort(mainPort).pipe(Scope.provide(childScope))
          yield* grant(rendererPort).pipe(
            Effect.tap(() => Effect.sync(() => { transferred = true })),
            Effect.uninterruptible
          )
        })
        const transactionExit = yield* restore(transaction).pipe(Effect.exit)
        if (Exit.isSuccess(transactionExit)) return
        yield* Ref.set(broker.current, Option.none())
        yield* Scope.close(childScope, transactionExit)
        yield* Effect.sync(() => {
          mainPort?.close?.()
          if (!transferred) rendererPort?.close()
        })
        return yield* Effect.failCause(transactionExit.cause)
      })
    )
  )
})

const closeRpcPort = Effect.fn("DesktopMain.closeRpcPort")(function* <
  Port extends PortEndpoint,
  R
>(broker: RpcPortBroker<Port, R>) {
  return yield* broker.semaphore.withPermit(
    Effect.gen(function* () {
      const current = yield* Ref.getAndSet(broker.current, Option.none())
      if (Option.isSome(current)) yield* Scope.close(current.value, Exit.void)
    })
  )
})

const ownMainPort = (port: PortEndpoint): MainPortLike => {
  let closed = false
  return {
    postMessage: (message) => port.postMessage(message),
    on: (event, listener) => port.on(event, listener),
    off: (event, listener) => port.off?.(event, listener),
    start: () => port.start(),
    close: () => {
      if (closed) return
      closed = true
      port.close()
    }
  }
}
