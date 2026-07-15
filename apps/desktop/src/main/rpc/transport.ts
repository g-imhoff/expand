import { Context, Effect } from "effect"
import type { ClientSession } from "@expand/client-ts"
import type { ProjectClient } from "@expand/client-ts/project"
import type { ServerClient } from "@expand/client-ts/server"
import { type MainPortLike, runRpcServer } from "@expand/desktop/main/rpc/server"
import { supervised } from "@expand/desktop/main/lib/supervised"

export interface RpcRuntime {
  readonly contextEffect: Effect.Effect<Context.Context<DesktopRpcServices>, unknown>
}

export interface ConnectPortDeps {
  readonly port: MainPortLike
  readonly runtime: RpcRuntime
}

export const connectPort = Effect.fn("DesktopMain.connectPort")(function* ({
  port,
  runtime
}: ConnectPortDeps) {
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    port.close?.()
  }
  const ownedPort: MainPortLike = {
    postMessage: (message) => port.postMessage(message),
    on: (event, listener) => port.on(event, listener),
    off: (event, listener) => port.off?.(event, listener),
    start: () => port.start(),
    close
  }
  yield* Effect.addFinalizer(() => Effect.sync(close))
  yield* runtime.contextEffect.pipe(
    Effect.flatMap((context) => runRpcServer(ownedPort).pipe(Effect.provide(context), Effect.scoped)),
    (effect) => supervised("desktop-main rpc bridge", effect),
    Effect.ensuring(Effect.sync(close)),
    Effect.forkScoped
  )
})

type DesktopRpcServices = ClientSession | ProjectClient | ServerClient
