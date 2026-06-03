import { createContext, useContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { type RpcClient, type RpcClientError } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"

// The renderer's RPC client type, reconstructed from the CONTRACT (never imported
// from client-core, which I-1 forbids). Mirrors packages/client-core/with-client.ts.
export type YodeaClient = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

// A tiny runtime supplying no services: the RpcClient is built in client.ts with
// its own connection-scoped Scope + RpcSerialization.json provided locally, so the
// runtime itself needs no platform layer. Effect core runs in the browser.
export const makeRendererRuntime = () => ManagedRuntime.make(Layer.empty)
export type RendererRuntime = ReturnType<typeof makeRendererRuntime>

export interface RpcContextValue {
  readonly runtime: RendererRuntime
  readonly client: YodeaClient
}
export const RpcContext = createContext<RpcContextValue | null>(null)
export const useRpc = (): RpcContextValue => {
  const ctx = useContext(RpcContext)
  if (!ctx) throw new Error("useRpc must be used within <Providers>")
  return ctx
}
