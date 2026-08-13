import { Context, Layer, Stream } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import type { SequencedEvent } from "@expand/contracts/events/domain"
import { specializeEventStore } from "@expand/server/db/event-store"

export class ReplayFeed extends Context.Service<ReplayFeed, {
  readonly read: (fromSeq: number) => Stream.Stream<SequencedEvent, SqlError>
}>()("expand/ReplayFeed", {
  make: specializeEventStore((store) => ({
    read: (fromSeq: number) => store.scan({ afterSeq: fromSeq })
  }))
}) {}

export const ReplayFeedLayer = Layer.effect(ReplayFeed, ReplayFeed.make)
