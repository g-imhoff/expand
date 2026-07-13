import { Context, Effect, Queue, type Scope, Stream } from "effect"
import { RpcClient, type RpcClientError, type RpcMessage, RpcSerialization } from "effect/unstable/rpc"
import { ExpandRpcs } from "@expand/contracts/rpc"
import type { RendererPortLike } from "@expand/desktop/renderer/rpc/renderer-port"
import { supervised } from "@expand/desktop/renderer/lib/supervised"

export class RendererRpcClient extends Context.Service<RendererRpcClient, RendererRpcClientApi>()(
  "expand/desktop/RendererRpcClient"
) {}

export type RendererRpcClientApi = RpcClient.FromGroup<typeof ExpandRpcs, RpcClientError.RpcClientError>

export const buildRendererClient = (
  port: RendererPortLike
): Effect.Effect<RendererRpcClientApi, never, Scope.Scope> =>
  RpcClient.make(ExpandRpcs).pipe(
    Effect.provideServiceEffect(RpcClient.Protocol, makePortProtocol(port)),
    Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json)
  )

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
        (eff) => supervised("renderer rpc inbound", eff),
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
