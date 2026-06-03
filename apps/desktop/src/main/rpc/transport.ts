import { Effect, Fiber } from "effect"
import type { ManagedRuntime } from "effect"
import type { ProjectStore } from "@yodea/client-core"
import { type MainPortLike, runRpcServer } from "@yodea/desktop/main/rpc/server"

export interface ConnectPortDeps {
  readonly port: MainPortLike
  readonly runtime: ManagedRuntime.ManagedRuntime<ProjectStore, never>
}

// Wire one window's port to its own serialized RpcServer, held alive by a single
// forked fiber whose scope lives until teardown. `RpcServer.make` runs forever
// (its transport receive/send loops are forked into the scope); `Effect.scoped`
// owns the lifetime and `Fiber.interrupt` ends it — closing the scope, stopping
// the transport loops, and interrupting the Connect/Events stream fibers. So a
// closed window can never receive a post-destroy send and no fiber leaks.
export const connectPort = ({ port, runtime }: ConnectPortDeps): (() => Promise<void>) => {
  const fiber = runtime.runFork(runRpcServer(port).pipe(Effect.scoped))
  return () => Effect.runPromise(Fiber.interrupt(fiber))
}
