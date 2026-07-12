import { Effect, Queue, type Scope, Stream } from "effect"
import { type RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectStore } from "@expand/client-ts/project"
import { DesktopRpcHandlers } from "@expand/desktop/main/rpc/handlers"
import { supervised } from "@expand/desktop/main/lib/supervised"

export interface MainPortLike {
  postMessage: (message: unknown) => void
  on: (event: "message", cb: (e: { data: unknown }) => void) => void
  start: () => void
}

export const runRpcServer = (
  port: MainPortLike
): Effect.Effect<never, never, ProjectStore | Scope.Scope> =>
  RpcServer.make(ExpandRpcs).pipe(
    Effect.provide(DesktopRpcHandlers),
    Effect.provideServiceEffect(RpcServer.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )

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
      yield* Stream.fromQueue(inbound).pipe(
        Stream.runForEach((data) => {
          const requests = parser.decode(data) as ReadonlyArray<RpcMessage.FromClientEncoded>
          return Effect.forEach(requests, (request) => writeRequest(0, request), { discard: true })
        }),
        (eff) => supervised("desktop-main rpc inbound", eff),
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
