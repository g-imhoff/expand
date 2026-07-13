# `@expand/client-ts` — ergonomics findings

What actually felt awkward while writing the three examples in this directory
against the SDK's public surface. Each finding is anchored to the file/line that
provoked it, so a future cleanup can act on it. These are observations, not
change requests — acting on them is a separate follow-up (see the spec's "Out of
scope").

Ordered roughly by how much friction each caused.

## 1. The store/facade split is addressed; one low-level escape hatch remains

The removed shared project store used to duplicate the project command vocabulary
with different names, argument shapes, and error semantics. That ambiguity is
gone. The examples now have one domain-level choice:

- **`ProjectClient`** — payload-object arguments, one RPC per method, and the
  full typed error union (`project/client.ts:13-35`).
- **`withClient(adapter, use)`** — a one-shot escape hatch that exposes the raw
  `ExpandRpcClientApi` with PascalCase RPC names (`with-client.ts:6-13`).

`bootstrap-projects.ts` and `archive-stale.ts` use `ProjectClient`, which can
express create-if-absent and recover from conflicts through `catchTags`. The
remaining distinction is intentional but still requires a reader to know that
`withClient` is transport-level plumbing rather than a second domain API.

**Possible cleanup:** keep `withClient` documented as the raw one-shot escape
hatch and point normal project consumers directly to `ProjectClient`.

## 2. There is a convenience runner, but not for the facades — so the boilerplate stays

Every example ends with the same runtime incantation
(`bootstrap-projects.ts:39-45`, `archive-stale.ts:22-28`,
`audit-log.ts:62-70`):

```ts
const runtime = ManagedRuntime.make(
  clientLayer(adapter).pipe(Layer.provide(NodeServices.layer))
)
runtime.runPromise(program).then(
  () => runtime.dispose(),
  (err) => { console.error(err); return runtime.dispose().finally(() => process.exit(1)) }
)
```

The SDK already ships a runner, but it does not fit the facade path.
`withClient(adapter, use)` (`with-client.ts`) performs the build/run/teardown
wrapping for the low-level `ExpandRpcClientApi`. The moment a consumer wants the
typed `ProjectClient`, it must hand-roll `ManagedRuntime` and the two-arm
`.then(dispose, …)` teardown.

**Possible cleanup:** add a facade-tier runner such as
`runProjectClient(adapter, (client) => Effect<…>)`, mirroring `withClient` at the
tier consumers normally use. It would delete the repeated tail from all three
examples.

## 3. "Public API only" leaks platform and application composition

The examples are meant to import *only* `@expand/client-ts` and
`@expand/client-ts/adapters/node`. In practice every one of them also imports
`effect` (`Effect`, `Layer`, `ManagedRuntime`, `Stream`) and, critically,
`NodeServices` from `@effect/platform-node` (`bootstrap-projects.ts:1-2`, etc.).

That second import isn't optional: `ClientLayer(adapter)` requires both
`FileSystem.FileSystem` and `AppContext`. The example-owned `clientLayer`
helper supplies `nodeAppContextLayer` directly before each entrypoint supplies
`NodeServices.layer`. The context layer therefore receives `Path.Path` and
`Stdio.Stdio`, acquires home and cwd lazily, and maps `Stdio.args` through the
pure `dataDirFromArgs` helper. The Node consumer still names the platform
separately from selecting the Node adapter while retaining explicit application
ownership of context composition.

**Possible cleanup:** have `makeNodeAdapter` or the Node subpath provide the Node
`FileSystem` itself while preserving application ownership of `AppContext`, so
the adapter choice does not need a second platform layer.

## 4. Data-dir isolation is application-owned, not an SDK option

Pointing the client and the backend it spawns at an isolated data directory (the
one thing every smoke test needs, and any embedding host will eventually need)
is still done by injecting `--data-dir <dir>` into the child argv
(`test/helpers.ts:36`). The application layer reads those arguments through the
`Stdio` service, derives a pure `AppContext`, and then provides that context to
the SDK. There is no ambient default and no `ClientLayer(adapter, { dataDir })`
or adapter option.

Standalone applications can retain argv behavior, while an embedding host can
provide `AppContext` directly or call its Node context adapter with an explicit
data directory. The remaining gap is convenience rather than control: the SDK
does not expose a data-directory option itself.

**Possible cleanup:** surface the data dir as an adapter or `ClientLayer` option
that flows into `resolveBackendCommand` and spawn rather than piggybacking on
argv.

## 5. Typed errors guide you well — but the per-method error union is easy to guess wrong

This is the finding where the SDK came out ahead: `Effect.catchTags` is checked
exhaustively against the method's error channel, so the compiler tells you
exactly which domain errors a call can produce.

The friction was that the intuited error set was wrong, and only tsc caught it.
The natural guess for `create` was
`ProjectAlreadyExists | ProjectNameConflict | ProjectDirectoryConflict |
ProjectInvalidInput`. The actual channel is
`… | ProjectAlreadyExists | ProjectDirectoryInvalid | ProjectDirectoryConflict |
ProjectInvalidInput` (`project/client.ts:14-18`) — no `ProjectNameConflict`, and
a `ProjectDirectoryInvalid` you would not have listed. `ProjectNameConflict`
lives only on `rename` (`project/client.ts:19`); creating with a duplicate name
is `ProjectAlreadyExists`, not a name conflict. `bootstrap-projects.ts:24-31`
reflects the corrected set.

The types are a genuine asset, but the create-versus-rename split is not obvious,
and all six tags are flat on the `/project` entrypoint
(`project/index.ts:23-30`). Reading the method signature is mandatory; the
entrypoint alone does not narrow them per operation.

## 6. `ProjectClient.events` is replayable but bound to one session epoch

The public facade can express a raw change stream:
`ProjectClient.events({ fromSeq })` returns `Stream<SequencedEvent>` and the
server replays events after that cursor (`project/client.ts:33-35`). This is an
improvement over the removed store's tail-only event hub: consumers can start
at zero for history or resume from a known sequence without a list snapshot.

The stream is still bound to the `ClientSession.current` value resolved when the
stream opens (`project/client.ts:62-65`). A reconnecting `ClientSession` does not
automatically migrate an existing `events` stream to its next epoch. The
long-running `audit-log.ts` therefore watches `ClientSession.status`, interrupts
the active tail on reconnect, retains a sequence cursor, and opens a new
`Events({ fromSeq })` tail after the next connected status
(`audit-log.ts:14-57`). The reconnect smoke test kills the backend and verifies
that sequences continue without duplication.

For synchronized project state, `@expand/contracts/project-sync` already owns
the list-then-`Events({ fromSeq })` lifecycle. Raw event consumers still need to
write the smaller cursor-and-reopen loop themselves.

**Possible cleanup:** document that facade streams are epoch-bound, or provide a
session-aware event-tail helper for consumers that need a process-long stream.

## 7. Branded outputs, raw-string inputs — an asymmetry that forces `String(...)`

Command inputs take plain strings by design — the client never references the
branded vocabulary (`project/client.ts:11-12`), so command ids and names are
`string`. The `Project` values returned by list and mutations are branded
(`Project.id`, `Project.name`). Feeding an id from a listed project into the next
call therefore needs an unwrap: `client.archive({ id: String(p.id) })`
(`archive-stale.ts:14`), and likewise `String(p.name)` for display or set
membership (`archive-stale.ts:16`, `bootstrap-projects.ts:19`).

Minor, but it is a papercut precisely because the input side went out of its way
to be brand-free while the output side did not — the round-trip needs a cast the
API's own philosophy says should not be necessary.

## 8. "Runs until interrupted" has no graceful-shutdown seam

`audit-log.ts` is specified to run until SIGINT, but the SDK offers no
shutdown/finalization hook, so the example has no signal handler. It relies on
the parent killing the process (`test/helpers.ts:99-101`) and on
`appendFileSync` being synchronous per event (`audit-log.ts:39-46`) so no
buffered line is lost when the process dies. `runtime.dispose()` never runs on
interrupt. It works, but "crash-safe by using sync fs writes and never cleaning
up" is a workaround, not a design. A long-running consumer would want an
interruptible run that flushes and disposes on SIGINT.

---

## 9. One flat barrel for four concerns (addressed: scoped entrypoints)

The whole public surface used to funnel through a single `index.ts` whose export
list needed section comments. Addressed on 2026-07-09: the surface is now scoped
— root equals the connection core, with `@expand/client-ts/project`,
`@expand/client-ts/server`, and `adapters/*` providing canonical subpaths.

---

### Net take

The Effect-native surface is genuinely good where it is typed: the error
channels (#5), replay cursor (#6), and removal of the competing store command
surface (#1) all help. The remaining friction clusters around setup and
lifecycle: facade-runner boilerplate (#2), platform-layer leakage (#3), a data
application-owned context wiring (#3), a data-directory knob that is not on the
SDK surface (#4), epoch-bound raw streams (#6),
branded round-trips (#7), and graceful shutdown (#8).
