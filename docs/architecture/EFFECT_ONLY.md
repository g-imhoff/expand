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

Official diagnostics, the local semantic rule, exact host-boundary validation, and tracked source coverage are cumulative evidence.

## Pure code stays pure

- The boundary is a functional core around an effectful shell: total deterministic calculations stay ordinary functions, while effectful behavior is represented by Effect, Stream, Layer, or a service.
- Pure code receives every value it needs as input, performs no I/O, inspects no ambient state, and is total over its declared inputs.

## Required Effect shapes

- Reusable named functions that return Effect use a named `Effect.fn` boundary; measured hot paths and anonymous protocol callbacks may use `Effect.fnUntraced`.
- `Effect.gen` is used for sequential control flow. Direct `map`, `flatMap`, `andThen`, and pipe-based combinators remain valid for expressions and small pipelines.
- Effect platform services are preferred whenever they model the capability; thin `Effect.try`, `Effect.tryPromise`, `Effect.callback`, or `Stream.callback` adapters are limited to missing services.
- Recoverable external failures are translated into tagged errors in the Effect error channel; impossible internal states are explicit defects.
- Resources have scoped release, finalizers, or interruption cleanup.

## Host adapters and runners

- Host adapters are exact by file, declaration, construct, and occurrence. Effect runners stay in registered entrypoints and framework bridges.
- Fire-and-forget work is owned and supervised so neither rejection nor Effect failure is silently discarded.

Host-required signatures translate into Effect at the adapter immediately. A
whole file, directory, or source tree is never an exception.

## Commands

Run the objective local gates:

```text
npm run lint
npm run typecheck:all
npm test
```

Pull-request reviewers inspect the diff for Effect adoption, host-adapter
legitimacy, resource ownership, interruption behavior, and Cause preservation.

## Permanent ratchets

The npm `prepare` lifecycle patches the local TypeScript binaries, so
`npm run typecheck:all` executes the configured Effect language-service errors,
warnings, and suggestions. Node builtin imports and `process.env` are disabled
in that duplicate diagnostic layer because the semantic ESLint rule and exact
host-boundary registry enforce them. The architecture suite pins the patch,
configuration, registry, and tracked source coverage. Human review covers the
judgment-heavy cases that cannot be reduced safely to a repository script.

## Completion

The project remains compliant only when all of the following evidence exists
from a fresh current checkout:

1. `npm run lint` and `npm run typecheck:all` pass with no blocking findings.
2. Architecture tests prove coverage of every tracked first-party source and
   canonical policy or configuration root without broad exclusion.
3. Human review finds no newly introduced native asynchronous control flow,
   ambient platform read, direct I/O, or unowned resource outside an approved
   adapter.
4. Static analysis, all TypeScript projects, dependency-cruiser, Knip, and the
   complete test suite pass.
5. CLI, server, library, package, Electron, benchmark, and documentation builds
   and certifications pass.
6. Runtime CLI/backend and desktop lifecycle certification passes.
7. Review finds no policy gap, exemption drift, resource leak, typed-error
    regression, or behavioral incompatibility.

A narrow test or the absence of obvious Promise syntax is not sufficient.
Static checks, behavior tests, runtime certification, and human review are
cumulative.
