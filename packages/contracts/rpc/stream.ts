import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SequencedEvent } from "@yodea/contracts/events/domain"

export class StreamRpcs extends RpcGroup.make(
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  Rpc.make("Events", {
    payload: { fromSeq: Schema.optionalKey(Schema.Int) },
    success: SequencedEvent,
    stream: true
  })
) {}
