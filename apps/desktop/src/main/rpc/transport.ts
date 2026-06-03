import { Effect, Fiber } from "effect"
import type { ManagedRuntime } from "effect"
import type { ProjectStore } from "@yodea/client-core"
import { type MainPortLike, runRpcServer } from "@yodea/desktop/main/rpc/server"

export interface ConnectPortDeps {
  readonly port: MainPortLike
  readonly runtime: ManagedRuntime.ManagedRuntime<ProjectStore, never>
}

export const connectPort = ({ port, runtime }: ConnectPortDeps): (() => Promise<void>) => {
  const fiber = runtime.runFork(runRpcServer(port).pipe(Effect.scoped))
  return () => Effect.runPromise(Fiber.interrupt(fiber))
}
