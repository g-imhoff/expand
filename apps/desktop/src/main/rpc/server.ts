import { Deferred, Effect, Exit, Queue, Scope, Stream } from "effect"
import { type RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { DesktopRpcHandlers } from "@expand/desktop/main/rpc/handlers"
import { supervised } from "@expand/desktop/main/lib/supervised"

export interface MainPortLike {
  postMessage: (message: unknown) => void
  on: {
    (event: "message", cb: (event: { data: unknown }) => void): void
    (event: "close", cb: () => void): void
  }
  off: {
    (event: "message", cb: (event: { data: unknown }) => void): void
    (event: "close", cb: () => void): void
  }
  start: () => void
  close?: () => void
}

export const runRpcServer = Effect.fn("DesktopMain.runRpcServer")((
  port: MainPortLike
): Effect.Effect<never, never, ClientSession | ProjectClient | ServerClient | Scope.Scope> =>
  RpcServer.make(ExpandRpcs).pipe(
    Effect.provide(DesktopRpcHandlers),
    Effect.provideServiceEffect(RpcServer.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )
)

const makePortProtocol = Effect.fn("DesktopMain.makePortProtocol")((port: MainPortLike) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const serialization = yield* RpcSerialization.RpcSerialization
      const parser = serialization.makeUnsafe()
      const ownerScope = yield* Scope.Scope
      const protocolScope = yield* Scope.fork(ownerScope)
      const inbound = yield* Queue.make<string | Uint8Array>()
      const disconnects = yield* Queue.make<number>()
      const remoteClosed = yield* Deferred.make<void>()
      yield* Scope.addFinalizer(protocolScope,
        Effect.all([Queue.shutdown(inbound), Queue.shutdown(disconnects)], { discard: true })
      )
      const listener = (e: { data: unknown }) => {
        Queue.offerUnsafe(inbound, e.data as string | Uint8Array)
      }
      const closeListener = () => {
        Queue.offerUnsafe(disconnects, 0)
        Deferred.doneUnsafe(remoteClosed, Effect.void)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          port.on("message", listener)
          port.on("close", closeListener)
        }),
        () =>
          Effect.sync(() => {
            port.off("message", listener)
            port.off("close", closeListener)
          }).pipe(
            Effect.ensuring(Effect.sync(() => port.close?.()))
          )
      ).pipe(Scope.provide(protocolScope))
      yield* Deferred.await(remoteClosed).pipe(
        Effect.andThen(Scope.close(protocolScope, Exit.void)),
        Effect.forkScoped
      )
      yield* Effect.sync(() => port.start())
      yield* Stream.fromQueue(inbound).pipe(
        Stream.runForEach((data) => {
          const requests = parser.decode(data) as ReadonlyArray<RpcMessage.FromClientEncoded>
          return Effect.forEach(requests, (request) => writeRequest(0, request), { discard: true })
        }),
        (eff) => supervised("desktop-main rpc inbound", eff),
        Effect.forkScoped,
        Scope.provide(protocolScope)
      )
      return {
        disconnects,
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
)
