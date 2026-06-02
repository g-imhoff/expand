import { Effect, Fiber } from "effect"
import type { ManagedRuntime } from "effect"
import { type RpcGroup, type RpcMessage } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { ProjectStore } from "@yodea/client-core"
import { makeRpcServer } from "@yodea/desktop/main/rpc/server"

type Rpcs = RpcGroup.Rpcs<typeof YodeaRpcs>

// EventEmitter-style port on the MAIN side (Electron MessagePortMain): .on('message'),
// .postMessage, .start. Structural so this module stays electron-free + Bun-testable.
export interface MainPortLike {
  postMessage: (message: unknown) => void
  on: (event: "message", cb: (e: { data: unknown }) => void) => void
  start: () => void
}

export interface ConnectPortDeps {
  readonly port: MainPortLike
  readonly runtime: ManagedRuntime.ManagedRuntime<ProjectStore, never>
}

const CLIENT_ID = 0

// Wire one window's port to its own RpcServer, held alive by a single forked
// fiber whose scope lives until teardown. `Effect.scoped` + `Effect.never` own
// the lifetime; `Fiber.interrupt` ends it — closing the scope and interrupting
// the Connect/Events stream fibers. So a closed window can never receive a
// post-destroy send and no fiber leaks.
export const connectPort = ({ port, runtime }: ConnectPortDeps): (() => Promise<void>) => {
  const fiber = runtime.runFork(
    Effect.gen(function* () {
      const server = yield* makeRpcServer((response) =>
        Effect.sync(() => port.postMessage(response)))
      port.on("message", (e) => {
        runtime.runFork(server.write(CLIENT_ID, e.data as RpcMessage.FromClient<Rpcs>))
      })
      port.start()
      yield* Effect.never // keep the scope (and the server's stream fibers) alive
    }).pipe(Effect.scoped)
  )
  return () => Effect.runPromise(Fiber.interrupt(fiber))
}
