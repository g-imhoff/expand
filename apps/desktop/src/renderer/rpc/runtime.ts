import { createContext, useContext } from "react"
import { Layer, ManagedRuntime } from "effect"
import { type RpcClient, type RpcClientError } from "effect/unstable/rpc"
import { YodeaRpcs } from "@yodea/contracts/rpc"

export type YodeaClient = RpcClient.FromGroup<typeof YodeaRpcs, RpcClientError.RpcClientError>

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
