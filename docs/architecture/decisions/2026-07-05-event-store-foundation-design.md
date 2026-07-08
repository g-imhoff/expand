# Event Store Foundation — streamed reads, specialized stores, projection checkpoints

- **Status:** approved (design), not yet implemented
- **Date:** 2026-07-05
- **Branch:** `feat/architectural-foundation`
- **Drives changes to:** `apps/server/db/*`, `apps/server/application/projections.ts`, `apps/server/rpc/stream.ts`, `scripts/fold-version.ts`, `docs/architecture/expand.c4` (storage description), `REVIEW.md`

## 1. Problem

`EventStore.readAll` / `readFrom` (`apps/server/db/event-store.ts`) execute one SQL statement, materialize **every** matching row into a single array, and decode every payload in memory. Three concrete failure modes as the log grows:

1. **Unbounded boot tail.** The persisted snapshot is written *only at boot* (`projections.ts:48,55`). Everything appended during a session is re-read and re-decoded at the next boot — and invariant I-4 (zero-connection shutdown) makes boots frequent. One long session taxes every boot after it.
2. **Unbounded memory.** Both read paths return `ReadonlyArray<SequencedEvent>` — whole-log residency is baked into the store API, including the RPC replay path (`rpc/stream.ts:26`).
3. **No structural room for heavy event families.** Everything shares one read path and one fold. A future high-volume entity (the motivating example: AI conversation history, with 10–500 KB payloads at agentic rates) would sit in the hot path of state that never needed it.

Research grounding (event-sourcing literature + SQLite benchmarks): SQLite itself is not the constraint — flat read latency at 100M rows, ~100k TPS at 1B rows in WAL mode. Event stores degrade through *full scans over fat payloads* and *unbounded materialization*, not row count. The standard remedies, in priority order: stream/keyset reads, checkpointed projections, stream design (short streams, payload claim-check), snapshots only after measurement, archiving last.

## 2. Decisions (with the questions that produced them)

| # | Question | Decision |
|---|----------|----------|
| D1 | Is full history replayable forever? | **Replayable, but cold** — rebuilds are rare offline operations, allowed to be slow. No deletion of history. |
| D2 | AI-conversation storage intent | **Descoped.** Conversations were an illustrative example only. No conversation events, tables, or payload machinery are built. The generic foundation must merely leave room for such a family (see §7). |
| D3 | Deployment topology | **Multi-device sync planned** (future). The global `seq` remains the single future sync cursor; nothing in this design forks the log or the sequence space. |
| D4 | Which pains matter | All four: boot time, query latency, memory, future sync volume. |
| D5 | Overall shape | **One log, specialized stores**: the `events` table stays the only source of truth; a slim generic `EventStore` base; domain-named store facades on top (`ProjectEventStore` now; e.g. `ConversationEventStore` someday). |
| D6 | Checkpoint write policy | **Debounced background fiber** (~500 ms quiet), plus final write on graceful I-4 shutdown. Commit path untouched. Chosen over per-commit writes to scale to future high-volume writers unchanged. |
| D7 | `snapshot` table → `projection_state` | **Drop + rebuild.** No data migration — the snapshot is a disposable cache; first boot after upgrade re-folds once. |
| D8 | Fold versioning | **Per-projection fold versions now.** `gen:fold-version` emits a hash per projection name. |
| D9 | Category concept | **No `category` column, no migration, no `SqliteMigrator`.** Specialized stores own their queries via `event_type` filters derived from their schema union. The `events` table is untouched. |
| D10 | Undecodable rows | **Fail fast.** Decode failure = defect with `{seq, stream_id, event_type, cause}`. Reverses the documented skip-with-warning trade-off (REVIEW.md:124, commits 15d3717/54a4d44). Repair tooling deferred until a failure ever occurs. |
| D11 | Where docs live | This document in `docs/architecture/decisions/` (committed — unlike the gitignored `docs/superpowers/`). |
| D12 | Branch / REVIEW.md | Same branch (`feat/architectural-foundation`). REVIEW.md sections rewritten in place **plus re-review markers** on already-DONE items whose described code changes. |

## 3. Target architecture

### 3.1 `EventStore` (base — generic primitives, not consumer-facing)

```ts
EventStore {
  append(streamId: string, event: DomainEvent): Effect<number, SqlError>   // unchanged
  scan(opts: { afterSeq?: number; eventTypes?: ReadonlyArray<string> })
    : Stream<SequencedEvent, SqlError>                                     // the ONE read primitive
}
```

`scan` mechanics:

- **Keyset pagination**: repeated `SELECT seq, stream_id, payload FROM events WHERE seq > ?cursor [AND event_type IN (...)] ORDER BY seq ASC LIMIT ?chunk` until a short chunk. Never `OFFSET` (cost grows linearly with offset).
- `EVENT_SCAN_CHUNK_SIZE = 1000` (named constant).
- **Each chunk is its own short read transaction** — a long-lived reader in WAL pins the end-mark and the WAL grows without bound; short re-entrant reads avoid this.
- **Decode per row, fail fast** (D10): failure dies with `{seq, stream_id, event_type, cause}`. The corrupt-row tolerance tests flip to assert the defect.
- `readAll` and `readFrom` are **deleted**. The offline full rebuild is `scan({})` consumed as a stream; RPC replay uses `scan({ afterSeq: fromSeq })`.

### 3.2 `ProjectEventStore` (first specialization — consumer-facing)

```ts
ProjectEventStore {
  read(fromSeq?: number): Stream<SequencedEvent, SqlError>
}
```

- Domain-named, typed; no stringly category anywhere in consumer code.
- Internally: `scan({ afterSeq: fromSeq, eventTypes: PROJECT_EVENT_TAGS })` where `PROJECT_EVENT_TAGS` is **derived from the `ProjectEvent` union** (`Object.keys(ProjectEvent.cases)`) — a new event variant updates the filter automatically. A lockstep-style test pins `filter tags === union tags`.
- Today the filter matches 100% of rows (the union is the whole vocabulary) and costs nothing. When a second event family makes it selective, this facade ships a **partial index** (`CREATE INDEX ... ON events(seq) WHERE event_type IN (...)`) — idempotent index-only DDL, still no table migration (see §7).

### 3.3 `ProjectionStateStore` (replaces `SnapshotStore`)

```sql
CREATE TABLE IF NOT EXISTS projection_state (
  name         TEXT PRIMARY KEY,
  state        TEXT,            -- nullable: reserved for future checkpoint-only rows (§7)
  last_seq     INTEGER NOT NULL,
  fold_version TEXT NOT NULL
) STRICT
```

- `load(name)` → `null` on absent/undecodable row; `save(name, state, lastSeq, foldVersion)` upserts. Same disposable-cache semantics as today: save/load failures are non-fatal warnings; only event-log read failures are defects.
- **State + cursor are one row, written in one UPSERT** — they can never disagree. This is the persisted mirror of the C2 invariant (`{projects, seq}` move atomically in one `SubscriptionRef`). A bare cursor is meaningless for an in-memory projection; fusing them is load-bearing, not incidental.
- DDL is idempotent, exactly like the existing tables: `CREATE TABLE IF NOT EXISTS projection_state` + `DROP TABLE IF EXISTS snapshot` (D7). No migrator — `SqliteMigrator` stays deferred until the first schema change to a *data-bearing* table, which this work no longer causes.

### 3.4 Per-projection fold versions (D8)

`scripts/fold-version.ts` emits a hash **per projection name** into `fold-version.generated.ts` (today: `projects` → hash of `Project` class + `projectsFromEvents`). The lockstep architecture test reshapes accordingly. A future projection's logic change invalidates only its own row.

### 3.5 `ProjectProjection` — boot, checkpointing, shutdown

Runtime truth for queries is unchanged: the in-memory `SubscriptionRef<{projects, seq}>`, advanced per commit by `apply` (seq-gated, idempotent). Queries never read SQL. `projection_state` is only the boot accelerator.

**Boot** (same shape as today, chunked):

1. `load('projects')` → missing or `fold_version ≠ FOLD_VERSIONS.projects` → full rebuild: fold `ProjectEventStore.read(0)` **chunk by chunk** (bounded memory; touches `projectsFromEvents`, which is a fold node → `gen:fold-version` regenerates).
2. Else tail catch-up: fold `ProjectEventStore.read(last_seq)`.
3. Save the resulting row; log `boot catch-up: {tailLength} events in {ms}` at Info (cheap observability so future tuning is data-anchored).

**During the session** (D6): a scoped background fiber observes `SubscriptionRef.changes`, debounces `CHECKPOINT_DEBOUNCE_MS = 500`, and UPSERTs the observed `{projects, seq}` pair. No writer race by construction: the commit path only writes the in-memory ref; the fiber only reads consistent pairs from it (C2) and persists them. A checkpoint may lag the newest commit — harmless; a snapshot is valid *at the seq it was taken*; boot replays the tail. Crash tail is bounded by the debounce window instead of session length.

**Shutdown** (I-4): scoped finalizers run in reverse — interrupt the debounce fiber **first**, then write the final checkpoint (best-effort, warn on failure), then close SQLite. Graceful cycles replay ~nothing at next boot.

### 3.6 RPC replay seam (`rpc/stream.ts`)

Backlog becomes `scan({ afterSeq: fromSeq })` (unfiltered — this is the future sync feed). `lastReplayed` can no longer be computed from a materialized array up front: it becomes a `Ref` **initialized to `fromSeq`** (so an empty backlog degrades correctly) and updated as backlog elements flow, and the live-feed dedup filter reads it. Safe because `Stream.concat` only starts the live side after the backlog completes, so the `Ref` is final when first consulted. The bus subscription still precedes the backlog read (no-gap guarantee unchanged). The pinned no-gap-no-duplicate obligation (`events-replay.test.ts`) gains a concurrent-appends-during-streamed-replay case.

## 4. Error handling

| Failure | Behavior |
|---|---|
| Event-log read / row decode | **Defect** with `{seq, stream_id, event_type, cause}`; boot refuses, replay stream dies loudly |
| `projection_state` load | Warning → rebuild from zero |
| `projection_state` save (debounced, boot, or shutdown) | Warning, continue — worst case a slower next boot, never wrong state |
| Debounce fiber death | Logged, non-fatal; checkpoint stops advancing, boot catch-up covers |
| Encode on `append` | Defect (unchanged — `orDie`) |

Recovery from a decode defect is a **code fix** (restore decodability / add an upcast), never data surgery. Contracts legacy-decode tests exist precisely to keep old rows decodable; a decode failure therefore always indicates a shipped regression.

## 5. Testing plan

Retargeted (pinned obligations survive):

- **`snapshot-equivalence.test.ts`** — the oracle *state at arbitrary seq k + tail ≡ fold-from-zero* is unchanged and already parametrizes prefix k, which is exactly what mid-session debounced checkpoints need. Extended with mid-session-k cases, retargeted at `projection_state`.
- **`projection.test.ts`** boot matrix (missing / `fold_version` mismatch / row + tail) — same semantics, new store.
- **`durability-restart.test.ts`** — checkpoint advances across restart.
- **`snapshot-store.test.ts`** → `projection-state-store.test.ts` (name-keyed, nullable state, per-name fold_version).
- **`event-store.test.ts`** — corrupt-row cases flip from "skips with warning" to "defects with context"; array-shape assertions move to stream consumption.
- **`fold-version-lockstep.test.ts`** — per-projection shape.
- **`events-replay.test.ts`** — no-gap-no-duplicate with streamed backlog + concurrent appends.

New:

- `scan`: no gap/duplicate **across chunk seams** (seed > 2× chunk size), `afterSeq` boundary semantics, `eventTypes` filtering, chunk-count assertion (proves keyset paging actually paginates).
- Debounced checkpoint: apply events → await debounce → row advanced **without** a reboot.
- Shutdown checkpoint: graceful I-4 exit → `last_seq` == committed max.
- `ProjectEventStore` filter lockstep: `PROJECT_EVENT_TAGS === ProjectEvent union tags`.

## 6. Documentation deliverables (same-commit discipline)

- **This ADR** — the architecture decision record for: store API reshape, projection generalization, and the D10 reversal of the skip-with-warning trade-off. Invariants I-1…I-4 are **not modified**; no BOUNDARIES.md rule changes.
- **`docs/architecture/expand.c4`** — storage component description updated (`Event log + snapshots` → event log + projection state; mention streamed reads).
- **`REVIEW.md`** (D12):
  - Rewrite Stage 2 item 2 (`db/event-store.ts`: `scan`, fail-fast decode) and item 4 (`ProjectionStateStore` + checkpoint cadence).
  - Rewrite scrutinize bullets at lines 124 (silent row-skip → fail-fast rationale) and 125 (guard (1) "written only at boot" → debounced cadence + shutdown write; guards (2)–(4) unchanged).
  - Update the read-model theme (line 53) and Stage 2 best-tests list (line 127).
  - Add **re-review markers** to already-DONE items whose described code changed — at minimum Stage 1 item 1 (`FOLD_VERSION` becomes per-projection).

## 7. Design-only appendix — how a future heavy event family plugs in (non-normative)

Recorded so the foundation's extension points are explicit. **None of this is built now** (D2). Illustrative example: AI conversation history at agentic volume (10–500 KB payloads).

- **Own specialized store** (`ConversationEventStore`): per-`stream_id` reads (`stream_id = conversationId`), the reserved `readStream(streamId)` naming, its own partial index over its tags.
- **Envelope events + claim-check payloads**: content-bearing events carry `payloadRef` (sha256, content-addressed); bodies live in a `payloads` table in the same DB (≤ ~100 KB — SQLite's in-DB/file crossover) or content-addressed files above it, written before/with the event so a crash can only orphan a payload, never dangle a reference. Never persist streaming token deltas; one complete message event on finish.
- **Short streams**: closing-the-books via a compaction/summary event (`…Compacted{summaryRef, throughSeq}`) — maps 1:1 onto LLM context compaction; replay starts at the last summary.
- **Own projection flavor**: SQL-materialized read model (state lives in real tables), `projection_state` row used checkpoint-only (`state = NULL`) with the checkpoint updated in the same transaction as the read-model tables.
- **Wire**: joining the `DomainEvent` union forces a `PROTOCOL_VERSION` bump anyway; the `Events` RPC gains its category/stream filter *then*, at zero extra cost.
- **Lifecycle**: archiving (flag or archive table, excluded from queries by default), payload GC only for tombstoned streams (forgettable-payloads pattern), `ATTACH`-based cold files — all deferred until cold data exists.

## 8. Out of scope

Conversation/AI features and their events (D2) · `PayloadStore` / claim-check machinery · `category` column, `SqliteMigrator`, any `events`-table schema change (D9) · `Events` RPC filter & protocol bump · archiving/compaction/GC · per-stream (aggregate) snapshots · upcaster machinery (fail-fast makes the need visible if it ever arises) · repair/dead-letter tooling (D10) · multi-device sync protocol (D3 only keeps the cursor viable).

## 9. Naming summary

| Old | New |
|---|---|
| `EventStore.readAll` / `readFrom` | `EventStore.scan({ afterSeq?, eventTypes? })` (base primitive) |
| — | `ProjectEventStore.read(fromSeq?)` (consumer-facing facade) |
| `SnapshotStore` / `snapshot` table | `ProjectionStateStore` / `projection_state` table |
| `FOLD_VERSION` (single hash) | `FOLD_VERSIONS` (per projection name) |
| — | `EVENT_SCAN_CHUNK_SIZE = 1000`, `CHECKPOINT_DEBOUNCE_MS = 500` (named tuning constants) |

`readStream(streamId)` is deliberately **reserved** (unbuilt) for per-`stream_id` reads so the word "stream" stays unambiguous: `scan` = ordered log traversal, `readStream` = one aggregate's events.
