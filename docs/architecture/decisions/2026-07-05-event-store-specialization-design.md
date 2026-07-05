# Event Store Specialization — capability-passing base, no ambient raw primitives

- **Status:** approved (design), not yet implemented
- **Date:** 2026-07-05
- **Branch:** `feat/architectural-foundation`
- **Extends:** `2026-07-05-event-store-foundation-design.md` (the foundation ADR). That ADR introduced `EventStore.scan`/`append` as a generic service with `ProjectEventStore` as a facade; this one removes the generic service from the program entirely.

## 1. Problem

After the foundation work, `EventStore` (`apps/server/db/event-store.ts`) is an ordinary DI service: any code in `apps/server` can `yield* EventStore` and call the raw primitives — an unfiltered `scan` (accidental full-log traversal in a hot path) or a raw `append(streamId, event)` (caller-supplied `streamId` that can disagree with `event.projectId`). The intended architecture is that feature code only ever talks to *specialized* stores (`ProjectEventStore` today, e.g. `ConversationEventStore` someday). We want that boundary **enforced, not conventional** — and enforced by the language/Effect, not by lint rules (a depcruise-guarded variant was explicitly rejected as flaky).

## 2. Decisions

| # | Question | Decision |
|---|----------|----------|
| S1 | Which primitives are fenced? | **Both `scan` and `append`, for all consumers.** No raw primitive is reachable by feature code; the two current direct consumers migrate to facades. |
| S2 | Enforcement mechanism | **Capability-passing factory** (evolved from a "sealed module" proposal after rejecting depcruise/testkit seams): the raw primitives never exist as a service — no tag, no layer, no context entry. They exist only as a closure handed to specialization builders. |
| S3 | File layout | Base machinery stays in `apps/server/db/event-store.ts`; `ProjectEventStore` moves to `apps/server/application/projects/project-event-store.ts` (next to `use-cases.ts`); the sync-feed specialization lives in `apps/server/db/replay-feed.ts`. |
| S4 | Test seam for chunking | `chunkSize` leaves the API. **`EventScanChunkSize`** is a `Context.Reference` (default 1000) exported from the base; tests override it locally (precedent: `AppContext`). A tuning knob is not a capability — overriding it is semantics-preserving. |
| S5 | Class inheritance (`protected`)? | Considered and dropped: in Effect, feature code holds service records, not instances, so `protected` would be decorative — the load-bearing move is removing the capability from the DI graph, which the factory does more strictly and without introducing the repo's only class hierarchy. |

## 3. Target architecture

### 3.1 `apps/server/db/event-store.ts` — the base

Module-private: the `events` DDL, `EventRow`, `decodeRowStrict`, `fetchChunk`. Exported:

```ts
/** Chunk granularity for keyset scans. Tests override locally; production uses the default. */
export const EventScanChunkSize: Context.Reference<EventScanChunkSize, number> // default 1000

export interface ScanOptions {
  readonly afterSeq?: number
  readonly eventTypes?: ReadonlyArray<string>
}

/** The raw capability SHAPE. Values of this type exist only inside specialization builders. */
export interface EventStorePrimitives {
  readonly append: (streamId: string, event: DomainEvent) => Effect.Effect<number, SqlError>
  readonly scan: (options?: ScanOptions) => Stream.Stream<SequencedEvent, SqlError>
}

/**
 * THE ONLY DOOR to the raw primitives. Acquires SqlClient, ensures the events DDL
 * (idempotent), reads EventScanChunkSize ONCE at build time (chunk granularity is
 * fixed per store instance — tests override the Reference when building the layer),
 * builds the primitives as a closure and hands them to the specialization builder. Creating a specialized store via this
 * factory is the sanctioned extension mechanism for new event families.
 */
export const specializeEventStore: <S>(
  build: (store: EventStorePrimitives) => S
) => Effect.Effect<S, SqlError, SqlClient>
```

**Deleted:** the `EventStore` `Context.Service`, `EventStoreLayer`, and `ScanOptions.chunkSize`.

### 3.2 Why this is strict (the two locks, and why v3 needs only one)

Effect's context system is a capability system: using a service requires *naming its tag* and *having it provided*. A sealed-module design still had the primitives as an internal service — one lock per direction. The factory design is stronger: **the primitives are never a service at all.** There is no tag to name, no layer to smuggle, nothing in any context — so there is nothing for feature code to `yield*`, and no `R`-channel requirement to satisfy or leak. The capability is unrepresentable outside a builder callback.

**The honest caveat, by design:** `specializeEventStore` itself is importable anywhere in `apps/server`. Calling it is not a hole in the fence — it is the gate: the call *declares a new specialized event store*, which is exactly the sanctioned architectural act (a future `ConversationEventStore` uses the same door from its own domain folder). Misuse is loud, greppable (`specializeEventStore(`), reviewable, and yields a well-formed named store rather than ambient raw access.

### 3.3 `apps/server/application/projects/project-event-store.ts`

```ts
export class ProjectEventStore extends Context.Service<ProjectEventStore, {
  readonly read: (fromSeq?: number) => Stream.Stream<SequencedEvent, SqlError>
  readonly append: (event: ProjectEvent) => Effect.Effect<number, SqlError>
}>()("yodea/ProjectEventStore", {
  make: specializeEventStore((store) => ({
    read: (fromSeq = 0) => store.scan({ afterSeq: fromSeq, eventTypes: PROJECT_EVENT_TAGS }),
    append: (event) => store.append(event.projectId, event)   // stream_id DERIVED — the
  }))                                                          // caller-supplied-id footgun is
}) {}                                                          // unrepresentable
```

`PROJECT_EVENT_TAGS` moves here with it (still derived from the `ProjectEvent` union; still pinned by its lockstep test). Note recorded honestly: the `ProjectEvent` parameter narrowing is *type-vacuous today* (the `DomainEvent` union currently equals the 7 project events); it becomes load-bearing when a second family joins the union. The derived `stream_id` is the material win now.

### 3.4 `apps/server/db/replay-feed.ts`

```ts
export class ReplayFeed extends Context.Service<ReplayFeed, {
  /** The unfiltered, seq-ordered feed — backlog replay today, the sync feed tomorrow. */
  readonly read: (fromSeq: number) => Stream.Stream<SequencedEvent, SqlError>
}>()("yodea/ReplayFeed", {
  make: specializeEventStore((store) => ({
    read: (fromSeq) => store.scan({ afterSeq: fromSeq })
  }))
}) {}
```

Placement rationale: it is a storage-read concern with no domain owner yet; it moves if a sync domain folder ever appears.

### 3.5 Consumer migrations (behavior identical everywhere)

- `application/projects/use-cases.ts`: depends on `ProjectEventStore` instead of `EventStore`; `commit(id, event)` becomes `commit(event)` (`stream_id` now derived inside `append`); ordering (`append → apply → publish`), `Semaphore(1)`, uninterruptibility untouched.
- `rpc/stream.ts`: `EventStore.scan({ afterSeq: fromSeq })` → `ReplayFeed.read(fromSeq)`; the `Ref`-tracked dedup gate is unchanged.
- `application/projections.ts`: import path change only (`ProjectEventStore` moved).
- `composition/app.ts`: wires `ProjectEventStoreLayer` + `ReplayFeedLayer` over `sql`; no base layer exists to wire. DDL runs once per specialization layer build — idempotent `CREATE IF NOT EXISTS`, the same multiplicity today's test wiring already exercises.

## 4. Testing plan

Retarget, don't re-prove — semantics are identical:

- `event-store.test.ts` (base mechanics): chunk seams, `afterSeq` exclusivity, empty log, corrupt-row defect, missing-table defect, and the `toPull` concurrent-append test run through **`ReplayFeed.read`**, with chunk tests overriding `EventScanChunkSize = 2` locally (the override is itself the Reference's test). Seeding via `ProjectEventStore.append`. The arbitrary-tag-subset filter test is **dropped** (no consumer; the foreign-row test pins the filter mechanism).
- `project-event-store.test.ts`: moves its imports to the new path; **new assertion:** an appended row's `stream_id` equals `event.projectId` (raw SQL check). The tag-lockstep pin (7 literals vs union keys) is unchanged.
- Wiring sweeps: `events-handler.test.ts` (handler consumes `ReplayFeed`), `use-cases`, `snapshot-equivalence`, `projection`, `trust-boundary`, and app-level tests swap `EventStoreLayer` for the two specialization layers. Assertions unchanged.
- Untouched: `events-replay` (wire-level), checkpoint-cadence, fold-version, durability suites.

## 5. Documentation deliverables (same-commit discipline)

- This ADR.
- `REVIEW.md`: Stage 2 item 2 rewritten (base factory + the two specializations and their locations); the `fromSeq` scrutinize bullet's `scan` mention → `ReplayFeed.read`; item 6's `commit` description notes the dropped `id` parameter. Affected items are unreviewed — no new `REREVIEW` markers required.
- `test/architecture/backend-ownership.test.ts`: existence list gains `apps/server/application/projects/project-event-store.ts` and `apps/server/db/replay-feed.ts`.
- `docs/architecture/yodea.c4`: unchanged (storage description already accurate). No invariant changes; I-1..I-4 unaffected.

## 6. Out of scope

Any new event family or specialization beyond the two that exist · sync protocol · depcruise rules or testkit modules for this boundary (explicitly rejected) · class-based store hierarchies (S5) · changes to scan/append semantics, chunking, fail-fast decode, or checkpoint behavior (all pinned by the foundation ADR and its tests).
