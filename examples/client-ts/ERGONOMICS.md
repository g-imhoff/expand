# `@expand/client-ts` — ergonomics findings

What actually felt awkward while writing the three examples in this directory
against the SDK's public surface. Each finding is anchored to the file/line that
provoked it, so a future cleanup can act on it. These are observations, not
change requests — acting on them is a separate follow-up (see the spec's "Out of
scope").

Ordered roughly by how much friction each caused.

## 1. Three overlapping command surfaces, and the reactive one can't dedup

The SDK exposes three ways to issue a project command, and picking the right one
was the first real decision in every example:

- **`ProjectClient`** facade — payload-object args, one RPC per method
  (`create({ name, ensure, directory })`, `archive({ id })`), full typed error
  union returned (`project-client.ts:12`).
- **`ProjectStore`** — positional args, *different* method names
  (`createProject(name, directory)`, `archiveProject(id)`), plus the reactive
  `projects`/`status`/`events`/`snapshot` mirror (`project-store.ts:18`).
- **`withClient(adapter, use)`** — a one-shot escape hatch handing you the raw
  `ExpandRpcClientApi` with PascalCase RPC names (`client.ProjectCreate({…})`)
  (`with-client.ts:5`, `index.ts:46`).

`bootstrap-projects.ts` and `archive-stale.ts` both landed on `ProjectClient`,
and *not* because the reactive store looked heavier — because the store's
command methods **can't express the dedup/skip semantics the task needed**.
`ProjectStore.createProject` hard-codes `ensure: true` and then `Effect.die`s on
`ProjectAlreadyExists` (`project-store.ts:204,207`). Bootstrap's whole point is
to create-if-absent and *report* the skip; on the store that conflict becomes an
unrecoverable defect instead of a typed error you can `catchTags`. So the choice
between the two command surfaces isn't stylistic — one of them silently removes
an error from the recoverable channel. That is not discoverable from the names.

The naming split compounds it: `create` vs `createProject`, `archive` vs
`archiveProject`, payload-object vs positional. Two vocabularies for the same
operations, and you can't tell from the barrel which tier owns the semantics you
want.

**Possible cleanup:** either give `ProjectStore` command methods parity with the
facade's error channel (don't `die` on a domain error), or document loudly that
the store's commands are "optimistic, throws-on-conflict" and the facade is the
"typed-outcome" path.

## 2. There is a convenience runner, but not for the facades — so the boilerplate stays

Every example ends with the exact same incantation
(`bootstrap-projects.ts:41-45`, `archive-stale.ts:22-26`, `audit-log.ts:22-26`):

```ts
const runtime = ManagedRuntime.make(ClientLayer(adapter).pipe(Layer.provide(BunServices.layer)))
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => { console.error(err); runtime.dispose(); process.exit(1) }
)
```

The seed hypothesis asked "should the SDK offer a `runWith(adapter, program)`?"
The finding is sharper than that: **the SDK already ships a runner — it just
doesn't fit the facade path.** `withClient(adapter, use)` (`with-client.ts`)
does exactly the "build layer, run, tear down" wrapping, but it resolves to the
low-level raw `ExpandRpcClientApi`, not `ProjectClient`/`ProjectStore`. So the
moment you want the typed facade (which #1 says you usually do), you fall back to
hand-rolling `ManagedRuntime` + the two-arm `.then(dispose, …)` teardown.

**Possible cleanup:** a facade-tier runner, e.g.
`runProjectClient(adapter, (client) => Effect<…>)` /
`runProjectStore(adapter, program)`, mirroring `withClient` but at the tier
consumers actually reach for. It would delete the identical 5-line tail from all
three examples.

## 3. "Public API only" leaks two peer dependencies

The examples are meant to import *only* `@expand/client-ts` and
`@expand/client-ts/adapters/bun`. In practice every one of them also imports
`effect` (`Effect`, `Layer`, `ManagedRuntime`, `Stream`) and, critically,
`BunServices` from `@effect/platform-bun` (`bootstrap-projects.ts:1-2`, etc.).

That second import isn't optional: `ClientLayer(adapter)` and
`ProjectStoreLayer(adapter)` both require a `FileSystem.FileSystem` in their
environment (`project-client.ts:55`, `project-store.ts:235`), which the consumer
satisfies with `.pipe(Layer.provide(BunServices.layer))`. So the Bun consumer
must know to add `@effect/platform-bun` and wire its layer, even though they
already selected the *Bun* adapter — the platform is named twice.

**Possible cleanup:** have `makeBunAdapter` / the Bun subpath provide the Bun
`FileSystem` itself, so `ClientLayer(bunAdapter)` needs no external platform
layer — the adapter choice already implies the platform.

## 4. Data-dir isolation is entirely off-surface (a magic argv flag)

Pointing the client and the backend it spawns at an isolated data directory (the
one thing every smoke test needs, and any embedding host will eventually need)
is done by injecting `--data-dir <dir>` into `process.argv`
(`test/helpers.ts:27`). It's read by the backend's `AppContext`, not by anything
on the SDK surface — there is no `ClientLayer(adapter, { dataDir })` or adapter
option for it.

This works for a standalone CLI whose argv is its own, but a program that embeds
the SDK inside a larger process (whose argv belongs to something else) has no
programmatic way to choose the data dir. Confirmed gap.

**Possible cleanup:** surface the data dir as an adapter/`ClientLayer` option
that flows into `resolveBackendCommand`/spawn, rather than piggybacking on argv.

## 5. Typed errors guide you well — but the per-method error union is easy to guess wrong

This is the finding where the SDK came out *ahead*: `Effect.catchTags` is checked
exhaustively against the method's error channel, so the compiler tells you
exactly which domain errors a call can produce.

The friction was that the intuited error set was wrong, and only tsc caught it.
The natural guess for `create` was
`ProjectAlreadyExists | ProjectNameConflict | ProjectDirectoryConflict |
ProjectInvalidInput`. The actual channel is
`… | ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict |
ProjectInvalidInput` (`project-client.ts:17`) — no `ProjectNameConflict`, and a
`ProjectDirectoryInvalid` you wouldn't have listed. `ProjectNameConflict` lives
only on `rename` (`project-client.ts:18`); creating with a duplicate name is
`ProjectAlreadyExists`, not a name conflict. `bootstrap-projects.ts:28-33`
reflects the corrected set.

So: the types are a genuine asset (you cannot ship a `catchTags` over the wrong
union), but the create-vs-rename split of which conflict is which is not
obvious, and all six tags being flat on the barrel (`index.ts:62-69`) means
nothing narrows them for you per call. Reading the method signature is
mandatory; the barrel alone will mislead.

## 6. `store.events` is tail-only — no backlog, and no gapless snapshot+subscribe

For `audit-log.ts` the probe question was whether the public surface can express
"observe the raw change stream." It can: `ProjectStore.events` is a
`Stream<SequencedEvent>` (`project-store.ts:41,200`) and
`Stream.runForEach(store.events, …)` tails it cleanly (`audit-log.ts:13`). Good.

The nuance the smoke had to work around: `events` is **live/tail-only**. It is
`Stream.fromPubSub(hub)`, and the hub only ever receives events published *after*
you subscribe and only for `seq` beyond the current fold
(`project-store.ts:164-168`); the initial connection snapshot is folded into
internal state but never republished to the hub (`project-store.ts:151-157`).
That's why `audit-log.smoke.test.ts:12-19` starts the tail, *then* causes the
change — a project created before the tail attaches would produce no line.

A consumer who wants "everything that ever happened" must read `store.snapshot`
(`project-store.ts:199`) for current state and tail `events` for the future — and
there is no single surface that hands you a gapless snapshot-then-subscribe, so
you'd have to reason about the seam between the two yourself. The example didn't
need history, so it stayed pure-tail; but the tail-only semantics are undocumented
on the `events` field and worth a doc line.

## 7. Branded outputs, raw-string inputs — an asymmetry that forces `String(...)`

Command inputs take plain strings by design — the client "never references the
branded vocabulary" (`project-client.ts:10-11`), so `create`/`archive` want
`string` ids and names. But the `Project` values you get *back* are branded
(`Project.id`, `Project.name`). Feeding an id from a listed project into the next
call therefore needs an unwrap: `client.archive({ id: String(p.id) })`
(`archive-stale.ts:14`), and likewise `String(p.name)` for display/set membership
(`archive-stale.ts:16`, `bootstrap-projects.ts:21`).

Minor, but it's a papercut precisely because the input side went out of its way to
be brand-free while the output side didn't — so the round-trip needs a cast the
API's own philosophy says shouldn't be necessary.

## 8. "Runs until interrupted" has no graceful-shutdown seam

`audit-log.ts` is specified to run until SIGINT, but the SDK offers no
shutdown/finalization hook, so the example has no signal handler: it relies on
the parent killing the process (`test/helpers.ts:56`) and on `appendFileSync`
being synchronous per event (`audit-log.ts:14-18`) so no buffered line is lost
when the process dies. `runtime.dispose()` never runs on interrupt. It works, but
"crash-safe by using sync fs writes and never cleaning up" is a workaround, not a
design. A long-running consumer would want an interruptible run that flushes and
disposes on SIGINT.

---

### Net take

The Effect-native surface is genuinely good where it's typed — the error
channels (#5) and the change stream (#6) both did their jobs. The friction
clusters around **choice and setup**: which of three command surfaces to use and
why (#1), boilerplate the existing runner doesn't cover (#2), a platform peer dep
the adapter choice should have implied (#3), and an isolation knob that isn't on
the surface at all (#4). Those four are where a small ergonomics pass would buy
the most.
