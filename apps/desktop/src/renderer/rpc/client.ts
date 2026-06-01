import type { Effect } from "effect"
import { RpcClient, type RpcGroup, type RpcMessage } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"

type Rpcs = RpcGroup.Rpcs<typeof YodeaRpcs>

// A structural port: satisfied by a DOM MessagePort. DOM-free so consumers
// typecheck under the root (non-DOM) tsconfig. Used by port.ts (production wiring).
export interface RendererPortLike {
  postMessage: (message: unknown) => void
  onmessage: ((event: { data: unknown }) => void) | null
  start: () => void
}

// Build the serialization-free RpcClient. Outbound client messages go through
// `sendToServer` (the in-memory test wires this to server.write; production
// wires it to port.postMessage). Returns `{ client, write }`: `client` is the
// typed contract client; `write` feeds INBOUND server messages in — the caller
// (test or port.ts) pumps its transport's messages into `write`.
export const buildClient = (
  sendToServer: (message: RpcMessage.FromClient<Rpcs>) => Effect.Effect<void>
) =>
  RpcClient.makeNoSerialization(YodeaRpcs, {
    onFromClient: ({ message }) => sendToServer(message)
  })
