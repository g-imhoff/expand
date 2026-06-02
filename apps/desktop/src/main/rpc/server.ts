import { Effect, Queue, type Scope, Stream } from "effect"
import { type RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectStore } from "@yodea/client-core"
import { DesktopRpcHandlers } from "@yodea/desktop/main/rpc/handlers"

// EventEmitter-style port on the MAIN side (Electron MessagePortMain): .on('message'),
// .postMessage, .start. Structural so this module stays electron-free + Bun-testable;
// the in-memory test pairs two of these back-to-back.
export interface MainPortLike {
  postMessage: (message: unknown) => void
  on: (event: "message", cb: (e: { data: unknown }) => void) => void
  start: () => void
}

// A serialized server Protocol over one MainPortLike (one server per window/port,
// so a single client id 0). Mirrors RpcServer.makeProtocolStdio: inbound encoded
// requests are decoded and fed to the RPC runtime; encoded responses are queued
// and posted back over the port. See ../renderer/rpc/client.ts for why the seam
// MUST be serialized (postMessage structured-clone strips Effect/Exit prototypes).
const makePortProtocol = (port: MainPortLike) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const serialization = yield* RpcSerialization.RpcSerialization
      const parser = serialization.makeUnsafe()
      const inbound = yield* Queue.make<string | Uint8Array>()
      port.on("message", (e) => {
        Queue.offerUnsafe(inbound, e.data as string | Uint8Array)
      })
      port.start()
      // Decode each inbound message and feed every framed request to client 0.
      yield* Stream.fromQueue(inbound).pipe(
        Stream.runForEach((data) => {
          const requests = parser.decode(data) as ReadonlyArray<RpcMessage.FromClientEncoded>
          return Effect.forEach(requests, (request) => writeRequest(0, request), { discard: true })
        }),
        Effect.forkScoped
      )
      return {
        disconnects: yield* Queue.make<number>(),
        send: (_clientId: number, response) => {
          const encoded = parser.encode(response)
          return encoded === undefined ? Effect.void : Effect.sync(() => port.postMessage(encoded))
        },
        end: (_clientId: number) => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true
      }
    })
  )

// Run a serialized RpcServer for the contract bound to one window's port. The
// handler layer (which requires ProjectStore) is provided here; ProjectStore +
// Scope come from the caller's runtime. RpcServer.make runs forever (never), so
// the caller forks it into a scope it controls for teardown.
export const runRpcServer = (
  port: MainPortLike
): Effect.Effect<never, never, ProjectStore | Scope.Scope> =>
  RpcServer.make(YodeaRpcs).pipe(
    Effect.provide(DesktopRpcHandlers),
    Effect.provideServiceEffect(RpcServer.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )
