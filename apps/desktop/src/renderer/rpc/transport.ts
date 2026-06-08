import { Context, Effect, Layer, Queue, type Scope, Stream } from "effect"
import { RpcClient, type RpcClientError, type RpcMessage, RpcSerialization } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"
import type { RendererPortLike } from "@yodea/desktop/renderer/rpc/renderer-port"

export type RendererRpcClientApi = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

export class RendererRpcClient extends Context.Service<RendererRpcClient, RendererRpcClientApi>()(
  "yodea/desktop/RendererRpcClient"
) {}

const makePortProtocol = (port: RendererPortLike) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      const serialization = yield* RpcSerialization.RpcSerialization
      const parser = serialization.makeUnsafe()
      const inbound = yield* Queue.make<string | Uint8Array>()
      port.onmessage = (event) => {
        Queue.offerUnsafe(inbound, event.data as string | Uint8Array)
      }
      port.start()
      yield* Stream.fromQueue(inbound).pipe(
        Stream.runForEach((data) => {
          const responses = parser.decode(data) as ReadonlyArray<RpcMessage.FromServerEncoded>
          return Effect.forEach(responses, (response) => writeResponse(0, response), { discard: true })
        }),
        Effect.forkScoped
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

export const buildRendererClient = (
  port: RendererPortLike
): Effect.Effect<RendererRpcClientApi, never, Scope.Scope> =>
  RpcClient.make(YodeaRpcs).pipe(
    Effect.provideServiceEffect(RpcClient.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )

export const RendererRpcClientLayer = (port: RendererPortLike): Layer.Layer<RendererRpcClient> =>
  Layer.effect(RendererRpcClient, buildRendererClient(port))
