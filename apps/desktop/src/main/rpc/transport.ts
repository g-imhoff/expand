import { Effect, Fiber } from "effect"
import type { ManagedRuntime } from "effect"
import type { BackendUnavailable, ProjectStore } from "@expand/client-core"
import { type MainPortLike, runRpcServer } from "@expand/desktop/main/rpc/server"
import { supervised } from "@expand/desktop/main/lib/supervised"

export interface ConnectPortDeps {
  readonly port: MainPortLike
  readonly runtime: ManagedRuntime.ManagedRuntime<ProjectStore, BackendUnavailable>
}

export const connectPort = ({ port, runtime }: ConnectPortDeps): (() => Promise<void>) => {
  const fiber = runtime.runFork(supervised("desktop-main rpc bridge", runRpcServer(port).pipe(Effect.scoped)))
  return () => Effect.runPromise(Fiber.interrupt(fiber))
}
