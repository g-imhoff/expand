import { Effect, Fiber } from "effect"
import type { ManagedRuntime } from "effect"
import type { BackendUnavailable, ClientSession } from "@expand/client-ts"
import type { ProjectClient } from "@expand/client-ts/project"
import type { ServerClient } from "@expand/client-ts/server"
import { type MainPortLike, runRpcServer } from "@expand/desktop/main/rpc/server"
import { supervised } from "@expand/desktop/main/lib/supervised"

export interface ConnectPortDeps {
  readonly port: MainPortLike
  readonly runtime: ManagedRuntime.ManagedRuntime<
    ClientSession | ProjectClient | ServerClient,
    BackendUnavailable
  >
}

export const connectPort = ({ port, runtime }: ConnectPortDeps): (() => Promise<void>) => {
  const fiber = runtime.runFork(supervised("desktop-main rpc bridge", runRpcServer(port).pipe(Effect.scoped)))
  return () => Effect.runPromise(Fiber.interrupt(fiber))
}
