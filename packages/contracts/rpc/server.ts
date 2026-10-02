import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"

export class ServerRpcs extends RpcGroup.make(
  Rpc.make("Health", { success: Schema.String })
) {}
