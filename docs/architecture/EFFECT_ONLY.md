# Effect-only boundary

Effect-only applies to effectful behavior, not deterministic calculation.

An operation must be represented by `Effect`, `Stream`, `Layer`, or an Effect
service when it performs or depends on any of the following:

- filesystem, process, network, IPC, terminal, or browser I/O;
- environment or command-line configuration;
- wall-clock time, timers, or randomness;
- asynchronous completion or cancellation;
- mutable concurrency or cross-fiber coordination;
- recoverable failure;
- acquisition and release of a resource.

Pure folds, reducers, formatting, routing, schema declarations, validation
predicates, path calculations over supplied inputs, React rendering, and other
total deterministic calculations remain ordinary functions. Wrapping them in
`Effect.succeed` would hide the functional core and is not part of the goal.

1. First-party APIs do not expose `Promise` for work the repository controls.
2. `async`, `await`, `new Promise`, and Promise chains do not implement
   first-party control flow.
3. Promise-shaped signatures exist only where a host framework requires them;
   the adapter immediately translates between the host and Effect.
4. Effect services are used whenever Effect models the platform capability.
5. A thin `Effect.try`, `Effect.tryPromise`, `Effect.callback`, or
   `Stream.callback` adapter is used only when Effect has no suitable service.
6. Reusable named functions that return Effect use `Effect.fn` by default.
   Anonymous protocol callbacks and measured hot paths may use
   `Effect.fnUntraced`.
7. Effect values use `Effect.gen` when they contain sequential control flow.
   Direct combinators remain valid for expressions and small pipelines.
8. Throwing synchronous APIs use `Effect.try`; `Effect.sync` is reserved for
   computations whose contract cannot throw.
9. Recoverable external failures use tagged errors in the Effect error channel.
10. Impossible internal states use defects deliberately rather than hidden
    `throw` statements.
11. Resource acquisition has a matching scoped release, finalizer, or
    interruption cleanup path.
12. Effect runners are confined to registered application entrypoints, test
    adapters, and framework bridges.
13. Fire-and-forget work is owned and supervised; Promise rejection and Effect
    failure are never silently discarded.

Official diagnostics, the local semantic rule, registry validation, source coverage, grep classifications, and launcher fingerprints are cumulative evidence.

## Pure code stays pure

- The boundary is a functional core around an effectful shell: total deterministic calculations stay ordinary functions, while effectful behavior is represented by Effect, Stream, Layer, or a service.
- Pure code receives every value it needs as input, performs no I/O, inspects no ambient state, and is total over its declared inputs.

## Required Effect shapes

- Reusable named functions that return Effect use a named `Effect.fn` boundary; measured hot paths and anonymous protocol callbacks may use `Effect.fnUntraced`.
- `Effect.gen` is used for sequential control flow. Direct `map`, `flatMap`, `andThen`, and pipe-based combinators remain valid for expressions and small pipelines.
- Effect platform services are preferred whenever they model the capability; thin `Effect.try`, `Effect.tryPromise`, `Effect.callback`, or `Stream.callback` adapters are limited to missing services.
- Recoverable external failures are translated into tagged errors in the Effect error channel; impossible internal states are explicit defects.
- Resources have scoped release, finalizers, or interruption cleanup.

## Host adapters and launchers

- Host adapters are exact by file, declaration, host, construct, and occurrence. Runners stay in registered entrypoints or bridges, and executable launchers are exact path, mode, classification, host, and source-fingerprint records.
- Fire-and-forget work is owned and supervised so neither rejection nor Effect failure is silently discarded.
- A launcher delegates immediately to the Effect entry program or repository gate and contains only the commands required by that host.

Host-required signatures translate into Effect at the adapter immediately. A
whole file, directory, or source tree is never an exception.

## Commands

Use the broad discovery command for fast human feedback:

```text
npm run effect:grep
```

Run the authoritative cumulative gate locally:

```text
npm run effect:audit
```

Shrink inventories after removing measured debt:

```text
npm run effect:audit:update
```

Search output is intentionally broad. It helps discovery, but it neither proves
compliance nor authorizes an exception.

## Migration inventories

The semantic ledger records existing blocking diagnostics. The grep inventory
classifies every broad-search candidate, and the launcher inventory records
every executable host path, mode, classification, host, and source fingerprint.
These inventories are exact migration ratchets rather than permanent allowances.

The update command may preserve an inventory or remove migration debt after the
corresponding source has changed. It cannot create a missing inventory or infer
a new classification. Non-debt classifications and fingerprints remain
reviewed registry data.

## Changing an exception

The update command is shrink-only. It cannot initialize a missing ledger, add debt, reclassify records, refresh reviewed non-debt fingerprints, or broaden an exception.

A legitimate permanent change requires an explicit reviewed registry edit with exact analyzer or fingerprint proof.

## Completion

The project is complete only when all of the following evidence exists from a
fresh current checkout:

1. `npm run effect:audit` passes the dedicated semantic project and repository
   gates with zero unapproved diagnostics.
2. Every `npm run effect:grep` match has one exact, validated candidate
   classification; executable exceptions are registered host boundaries only.
3. Architecture tests prove the audit is enabled, covers all tracked
   first-party source and executable launcher roots, and has no broad
   exclusion.
4. No native asynchronous control flow, ambient platform read, direct I/O, or
   unowned resource remains outside an approved adapter.
5. `npm run lint`, both TypeScript projects, dependency-cruiser, Knip, agent
   synchronization checks, and the full Vitest suite pass.
6. CLI and server builds pass compiled lifecycle certification.
7. Electron builds and the complete Playwright suite pass.
8. Library builds and publish-staging workflows pass.
9. The project-scoped manual and desktop testers certify their runtime scopes.
10. A broad final code review finds no policy gap, exemption drift, resource
    leak, typed-error regression, or behavioral incompatibility.

Search output, a green narrow test, or the absence of obvious Promise syntax is
not sufficient by itself. The semantic audit, repository rule, behavior tests,
runtime certification, and manual completion audit are cumulative evidence.

Semantic, grep, and launcher migration debt must all reach zero before temporary ledgers or migration-only validation are deleted.
