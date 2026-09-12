import { Cause, Deferred, Effect, Exit, Queue, Scope } from "effect"
import { type RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import { ClientSession } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { DesktopRpcHandlers } from "@expand/desktop/main/rpc/handlers"
import { supervised } from "@expand/desktop/main/runtime/supervised"
import {
  admitRpcIngressFrame,
  RPC_INGRESS_MAX_QUEUED_FRAMES,
  type RpcIngressFrame,
  rpcIngressFrameSize
} from "@expand/desktop/shared/rpc/ingress-limits"

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
      const inbound = yield* Queue.bounded<RpcIngressFrame>(RPC_INGRESS_MAX_QUEUED_FRAMES)
      const disconnects = yield* Queue.make<number>()
      const remoteClosed = yield* Deferred.make<void>()
      yield* Scope.addFinalizer(protocolScope,
        Effect.all([Queue.shutdown(inbound), Queue.shutdown(disconnects)], { discard: true })
      )
      // Synchronous admission gate: the single decoding fiber below cannot
      // exert backpressure on the port listener, so the listener enforces the
      // count/byte bounds itself. Any violation is a protocol failure that
      // closes the port and tears down this scope; frames are never silently
      // dropped, so accepted traffic stays ordered and lossless.
      //
      // Teardown runs on a supervisor fiber scoped to the owner (not this
      // protocol scope): closing the protocol scope from a fiber that lives
      // inside it would wait on itself forever, so the listener and consumer
      // only signal the failure and the supervisor performs the close.
      const protocolFailure = yield* Deferred.make<string>()
      let queuedFrames = 0
      let retainedBytes = 0
      let protocolFailed = false
      const signalFailure = (reason: string): void => {
        if (protocolFailed) return
        protocolFailed = true
        Deferred.doneUnsafe(protocolFailure, Effect.succeed(reason))
        // Surface the failure as a client disconnect so in-flight RPC calls
        // fail through the framework instead of hanging without responses.
        Queue.offerUnsafe(disconnects, 0)
      }
      yield* Deferred.await(protocolFailure).pipe(
        Effect.flatMap((reason) =>
          Scope.close(
            protocolScope,
            Exit.die(new Error(`[desktop-main rpc inbound] protocol failure: ${reason}`))
          )
        ),
        Effect.forkScoped
      )
      const listener = (e: { data: unknown }) => {
        if (protocolFailed) return
        const admission = admitRpcIngressFrame(e.data, { queuedFrames, retainedBytes })
        if (!admission.admitted) {
          signalFailure(admission.reason)
          return
        }
        queuedFrames += 1
        retainedBytes += admission.size
        Queue.offerUnsafe(inbound, e.data as RpcIngressFrame)
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
      const takeOne = Queue.take(inbound).pipe(
        Effect.tap((frame) =>
          Effect.sync(() => {
            queuedFrames -= 1
            retainedBytes -= rpcIngressFrameSize(frame)
          })
        )
      )
      const handleOne = (data: RpcIngressFrame) =>
        Effect.try({
          try: () => parser.decode(data) as ReadonlyArray<RpcMessage.FromClientEncoded>,
          catch: (error) => error
        }).pipe(
          Effect.flatMap((requests) =>
            Effect.forEach(requests, (request) => writeRequest(0, request), { discard: true })
          )
        )
      // A decoding failure means the peer sent bytes this side cannot parse.
      // The consumer must not die while the listener keeps buffering, so the
      // failure tears down the protocol scope (detaching the listener and
      // failing pending calls) instead of leaving a live producer behind.
      yield* Effect.forever(takeOne.pipe(Effect.flatMap(handleOne))).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => signalFailure("decode-failure")).pipe(Effect.andThen(Effect.failCause(cause)))
        ),
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
