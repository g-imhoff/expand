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

Run the authoritative cumulative gate locally:

```text
npm run effect:audit
```

Validate every broad-search observation against its exact reviewed proof:

```text
npm run effect:candidates
```

Validate every executable entrypoint and invocation against its exact reviewed
host, mode, and source fingerprint:

```text
npm run effect:launchers
```

`npm run effect:grep` remains a fast discovery aid. Its output neither proves
compliance nor authorizes an exception.

## Permanent ratchets

The audit executes the official language service once for errors, warnings, and
messages, the repository semantic rule, exact host-boundary validation, tracked
source coverage, candidate validation, and executable validation. It requires
zero warnings, rejects every unrecognized message, and permits only exact
registered host diagnostics.

The candidate gate requires zero unregistered candidates. Each retained search
observation has one exact source identity and reviewed proof. The executable
gate requires zero unregistered executables and exact entrypoint, invocation,
mode, host, and fingerprint agreement.

There is no command that rewrites these records. A legitimate permanent change
requires an explicit reviewed registry edit backed by current analyzer or
fingerprint evidence.

## Completion

The project remains compliant only when all of the following evidence exists
from a fresh current checkout:

1. `npm run effect:audit` passes with no blocking findings, zero warnings, and
   no unrecognized language-service messages.
2. `npm run effect:candidates` passes with zero unregistered candidates and an
   exact classification for every discovery observation.
3. `npm run effect:launchers` passes with zero unregistered executables and an
   exact fingerprinted invocation for every executable boundary.
4. Architecture tests prove coverage of every tracked first-party source,
   canonical policy/configuration root, and executable entrypoint without broad
   exclusion.
5. No native asynchronous control flow, ambient platform read, direct I/O, or
   unowned resource remains outside an approved adapter.
6. Static analysis, all TypeScript projects, dependency-cruiser, Knip, agent
   synchronization, and the complete test suite pass.
7. CLI, server, library, package, Electron, benchmark, and documentation builds
   and certifications pass.
8. Runtime CLI/backend and desktop lifecycle certification passes.
9. Candidate and executable registries remain canonical and byte-stable under
   validation.
10. Review finds no policy gap, exemption drift, resource leak, typed-error
    regression, or behavioral incompatibility.

Search output, a narrow test, or the absence of obvious Promise syntax is not
sufficient. The permanent audit, candidate gate, executable gate, behavior
tests, runtime certification, and review evidence are cumulative.
