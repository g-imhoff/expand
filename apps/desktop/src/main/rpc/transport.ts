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
  const on = ((event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)) => {
    if (event === "message") port.on(event, listener as (event: { data: unknown }) => void)
    else port.on(event, listener as () => void)
  }) as MainPortLike["on"]
  const off = ((event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)) => {
    if (event === "message") port.off(event, listener as (event: { data: unknown }) => void)
    else port.off(event, listener as () => void)
  }) as MainPortLike["off"]
  const ownedPort: MainPortLike = {
    postMessage: (message) => port.postMessage(message),
    on,
    off,
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
