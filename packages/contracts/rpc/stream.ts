import { Rpc, RpcGroup } from "effect/rpc"
import { Schema } from "effect"
import { SequencedEvent } from "@expand/contracts/events/domain"

export class EventsLagged extends Schema.TaggedError<EventsLagged>()(
  "EventsLagged",
  { lagCapacity: Schema.Int }
) {}

export class StreamRpcs extends RpcGroup.make(
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  Rpc.make("Events", {
    payload: { fromSeq: Schema.optionalKey(Schema.Int) },
    success: SequencedEvent,
    error: EventsLagged,
    stream: true
  })
) {}
