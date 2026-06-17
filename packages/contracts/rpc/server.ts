import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"

export class ServerRpcs extends RpcGroup.make(
  Rpc.make("Health", { success: Schema.String })
) {}
