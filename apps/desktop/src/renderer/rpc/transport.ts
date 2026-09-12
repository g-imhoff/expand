import { Cause, Context, Deferred, Effect, Exit, Queue, Scope } from "effect"
import { RpcClient, type RpcClientError, type RpcMessage, RpcSerialization } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { RendererPortLike } from "@expand/desktop/renderer/rpc/renderer-port"
import { supervised } from "@expand/desktop/renderer/app/supervised"
import {
  admitRpcIngressFrame,
  RPC_INGRESS_MAX_QUEUED_FRAMES,
  type RpcIngressFrame,
  rpcIngressFrameSize
} from "@expand/desktop/shared/rpc/ingress-limits"

export class RendererRpcClient extends Context.Service<RendererRpcClient, RendererRpcClientApi>()(
  "expand/desktop/RendererRpcClient"
) {}

export type RendererRpcClientApi = RpcClient.FromGroup<typeof ExpandRpcs, RpcClientError.RpcClientError>

export const buildRendererClient = Effect.fn("DesktopRenderer.buildRendererClient")((
  port: RendererPortLike
): Effect.Effect<RendererRpcClientApi, never, Scope.Scope> =>
  RpcClient.make(ExpandRpcs).pipe(
    Effect.provideServiceEffect(RpcClient.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )
)

const makePortProtocol = Effect.fn("DesktopRenderer.makePortProtocol")((port: RendererPortLike) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const serialization = yield* RpcSerialization.RpcSerialization
      const parser = serialization.makeUnsafe()
      const ownerScope = yield* Scope.Scope
      const protocolScope = yield* Scope.fork(ownerScope)
      const inbound = yield* Queue.bounded<RpcIngressFrame>(RPC_INGRESS_MAX_QUEUED_FRAMES)
      yield* Scope.addFinalizer(protocolScope, Queue.shutdown(inbound))
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
      }
      yield* Deferred.await(protocolFailure).pipe(
        Effect.flatMap((reason) =>
          Scope.close(
            protocolScope,
            Exit.die(new Error(`[renderer rpc inbound] protocol failure: ${reason}`))
          )
        ),
        Effect.forkScoped
      )
      const listener = (event: { data: unknown }) => {
        if (protocolFailed) return
        const admission = admitRpcIngressFrame(event.data, { queuedFrames, retainedBytes })
        if (!admission.admitted) {
          signalFailure(admission.reason)
          return
        }
        queuedFrames += 1
        retainedBytes += admission.size
        Queue.offerUnsafe(inbound, event.data as RpcIngressFrame)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => { port.onmessage = listener }),
        () =>
          Effect.sync(() => {
            if (port.onmessage === listener) port.onmessage = null
          }).pipe(
            Effect.ensuring(Effect.sync(() => port.close?.()))
          )
      ).pipe(Scope.provide(protocolScope))
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
          try: () => parser.decode(data) as ReadonlyArray<RpcMessage.FromServerEncoded>,
          catch: (error) => error
        }).pipe(
          Effect.flatMap((responses) =>
            Effect.forEach(responses, (response) => writeResponse(0, response), { discard: true })
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
        (eff) => supervised("renderer rpc inbound", eff),
        Effect.forkScoped,
        Scope.provide(protocolScope)
      )
      return {
        send: (_clientId: number, request) =>
          Effect.sync(() => {
            const encoded = parser.encode(request)
            if (encoded !== undefined) port.postMessage(encoded)
          }),
        supportsAck: true,
        supportsTransferables: false
      }
    })
  )
)
