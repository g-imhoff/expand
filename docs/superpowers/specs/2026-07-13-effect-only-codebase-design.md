# Effect-Only Codebase

## Goal

Make Effect the sole first-party model for side effects, asynchronous work,
recoverable failure, concurrency, configuration, and resource lifetime across
the repository. Add a fast search command for human discovery and an
authoritative semantic audit that prevents native Promise and platform effects
from returning outside explicitly registered host adapters.

The migration covers production applications and packages, Electron and UI
bridges, examples, benchmarks, repository scripts, tests, fixtures, and build
or packaging utilities. Completion means the entire first-party repository
satisfies one enforced Effect boundary, not merely that the main server and SDK
use Effect.

## Definition of Effect-Only

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

## Repository-Wide Invariants

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

## Scope

The policy covers tracked first-party TypeScript, TSX, MTS, CTS, JavaScript,
MJS, and CJS under applications, packages, scripts, examples, benchmarks,
migrations, test support, and root configuration.

The audit excludes dependency trees and generated build products such as
`node_modules`, `dist`, `out`, `coverage`, Playwright output, and test-result
directories. A tracked generated source file remains subject to the policy.
Historical design documents and lockfile metadata are not executable code and
are outside the semantic audit.

## Current-State Findings

The server, client SDK, CLI command layer, project synchronization controller,
and most RPC code already use Effect pervasively. Remaining inconsistencies
cluster at platform and framework edges rather than in domain logic.

The initial audit identified these high-priority gaps:

- server tokens and project identifiers are generated before or outside the
  returned Effect;
- project use cases read wall-clock time directly;
- endpoint discovery hides a process probe in a synchronous boolean helper;
- backend command resolution reads environment and filesystem state and throws
  from a public synchronous API;
- `AppContext` mixes pure path derivation with Node home-directory and argv
  acquisition inside the contracts package;
- spawn-lock and state-root-lock transactions use direct synchronous filesystem
  calls rather than the Effect filesystem service;
- Node child spawning does not register interruption cleanup;
- renderer boot creates a native Promise and immediately wraps it in Effect;
- MessagePort and RPC listeners do not all have explicit scoped ownership;
- Electron and IPC bridges discard some Promise failures after running Effects;
- React, Ink, Electron, benchmark, example, build, and maintenance code still
  contains native async control flow;
- tests rely broadly on `async`/`await` instead of one Effect-aware test
  adapter.

The migration must preserve pure project folds, TUI reducers, CLI formatting,
Zustand state transitions, sender validation, security predicates, and other
already-total calculations.

## Enforcement Architecture

### Official Effect diagnostics

Pin `@effect/language-service` as a development dependency and configure it in
the root and desktop TypeScript projects. TypeScript 6 uses this package rather
than the TypeScript 7-only `@effect/tsgo` replacement.

Run its standalone project diagnostic command in CI instead of patching the
installed TypeScript compiler. The audit enables semantic correctness rules and
promotes the relevant Effect-native boundary diagnostics to errors, including:

- `asyncFunction`;
- `newPromise`;
- `nodeBuiltinImport`;
- `globalConsole` and `globalConsoleInEffect`;
- `globalDate` and `globalDateInEffect`;
- `globalFetch` and `globalFetchInEffect`;
- `globalRandom` and `globalRandomInEffect`;
- `globalTimers` and `globalTimersInEffect`;
- `cryptoRandomUUID` and `cryptoRandomUUIDInEffect`;
- `processEnv` and `processEnvInEffect`;
- `preferSchemaOverJson`;
- `floatingEffect`;
- `lazyPromiseInEffectSync`;
- `runEffectInsideEffect`;
- `schemaSyncInEffect`;
- `tryCatchInEffectGen`;
- `globalErrorInEffectCatch` and `globalErrorInEffectFailure`.

Correctness diagnostics already emitted as errors remain enabled.
`effectFnOpportunity` remains advisory because it cannot distinguish a reusable
tracing boundary from a deliberately local composition. Repository review and
the coding convention below require `Effect.fn` for exported or reusable named
effectful operations. Style-only diagnostics unrelated to the Effect-only
invariant do not become mandatory as part of this project.

The repository exposes separate root and desktop audit scripts because the
existing root TypeScript project deliberately excludes Electron sources.
`npm run effect:audit` runs both and then the repository-specific ESLint gate.

### Repository-specific AST gate

Extend the local ESLint plugin with a focused Effect-boundary rule. It supplies
the policy that an upstream language service cannot infer:

- reject explicit Promise types outside registered host signatures;
- reject `.then`, `.catch`, and `.finally` Promise-style chains;
- reject Effect runners outside registered entrypoint or bridge functions;
- reject broad file or directory exemptions;
- reject unused or stale exemptions;
- enforce exact declaration identities for required host signatures.

The rule configuration owns a small structured exemption registry. Each entry
contains the file, declaration, host API, and permitted construct. Inline
disable comments are not the normal exemption mechanism, and a whole file is
never exempt merely because it is an adapter.

Representative legitimate host signatures include Electron's invoke and
handler Promise contracts and the single wrappers used to adapt Vitest and
Playwright callbacks. APIs such as `BrowserWindow.loadURL` or `esbuild.build`
are not exemptions: their Promises are consumed inside `Effect.tryPromise`.

### Fast ripgrep discovery

`npm run effect:grep` is a transparent, intentionally broad candidate finder.
It is useful during review and for contributors who want immediate feedback:

```sh
rg -n --hidden \
  -g '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}' \
  -g '!.git/**' \
  -g '!**/node_modules/**' \
  -g '!**/{dist,out,build,coverage,test-results,playwright-report}/**' \
  "\\basync\\b|\\bawait\\b|new\\s+Promise\\b|\\bPromise(?:Like)?\\s*<|\\bPromise\\.(?:all|allSettled|any|race|resolve|reject)\\b|\\.(?:then|catch|finally)\\s*\\(|\\b(?:setTimeout|setInterval|fetch)\\s*\\(|\\b(?:console\\.\\w+|Date\\.now|Math\\.random|crypto\\.randomUUID|process\\.env)\\b|\\bnode:(?:fs(?:/promises)?|timers(?:/promises)?|crypto|http|https|child_process)\\b|\\b(?:Effect|Runtime|NodeRuntime|BunRuntime)\\.run(?:Promise(?:Exit)?|Sync(?:Exit)?|Fork|Callback|Main)\\s*\\("
```

Search output is not proof of noncompliance because it includes type mentions,
comments, and legitimate adapters. The language-service and AST gates are the
authoritative proof. At completion, every remaining grep match must correspond
to the exact committed host-boundary inventory.

## Effect Coding Conventions

### Functions and values

Exported and reusable functions returning Effect use a named tracing boundary:

```ts
const operation = Effect.fn("Module.operation")(function* (input: Input) {
  const service = yield* Service
  return yield* service.execute(input)
})
```

An already-constructed program uses `Effect.gen`. A short expression may use
`map`, `flatMap`, `andThen`, or a pipe without a generator. `Effect.fn` and
`Effect.gen` are composition forms, not replacements for `Effect.tryPromise`,
`Effect.callback`, scoped acquisition, or a platform service.

### Platform capabilities

- `FileSystem` owns filesystem access.
- `Path` owns platform path operations when a service is needed.
- `Clock` and `DateTime` own time.
- `Crypto` owns secure bytes, tokens, and UUID generation.
- `Random` owns non-security-sensitive injected randomness.
- `Config` owns environment-derived configuration.
- Effect HTTP, socket, process, terminal, and SQL services own their respective
  capabilities.

Pure modules such as deterministic path manipulation over supplied values or a
constant-time byte comparison may remain ordinary functions when they perform
no I/O, inspect no ambient state, and are total over their declared inputs.

### Errors

External failures are translated once at their adapter boundary into a tagged
error meaningful to the caller. Error types retain the original cause where it
improves diagnostics. Parsing uses Schema, `Result`, or `Option`; a public
function does not throw because JSON, an environment value, or an external
payload is invalid.

Promise rejection is mapped with `Effect.tryPromise`. Callback APIs use
`Effect.callback` and return interruption cleanup when the callback installs a
listener or may create a late resource. A callback that cannot fail may use
`Effect.callback` without inventing a recoverable error.

### Resources and concurrency

Listeners, ports, child processes, files, locks, temporary paths, intervals,
runtimes, and background fibers have explicit ownership. Use scoped layers,
`acquireRelease`, `addFinalizer`, `ensuring`, or callback cancellation as fits
the API.

Atomic lock algorithms move to Effect filesystem operations inside an
uninterruptible transaction. Candidate and claim cleanup remains guaranteed,
and tests continue to prove token, inode, and stale-owner behavior. Conversion
must not weaken the existing cross-process ownership protocol.

## Migration Stages

### Stage 1: Audit foundation

- add and configure the Effect language service;
- implement and test the local Effect-boundary ESLint rule;
- add `effect:grep`, root/desktop diagnostic commands, and `effect:audit`;
- add CI and pre-commit enforcement;
- document the policy and initial exact host exemption registry;
- capture the initial diagnostic inventory as migration input rather than
  accepting it as a permanent baseline.

The final rule is introduced first so every later task reduces measured debt
and cannot add a new category of violation.

### Stage 2: Core runtime and SDK

- move token and identifier generation to `Crypto`;
- move timestamps and deadlines to `Clock`/`DateTime`;
- make process probes effectful;
- split backend command parsing from Effect-native environment and filesystem
  resolution;
- split pure `AppContext` path derivation from Node host acquisition;
- migrate spawn-lock and state-root-lock transactions to `FileSystem`;
- use named `Effect.fn` boundaries for reusable server and SDK operations;
- update public types and all consumers where these changes intentionally make
  synchronous throwing APIs effectful.

### Stage 3: Host and resource boundaries

- make Node child spawning cancellable and listener-safe;
- replace renderer boot's Promise barrier with `Deferred`;
- make MessagePort and RPC listener ownership scoped;
- introduce one supervised IPC callback runner;
- convert Electron and Ink startup/shutdown to Effect entry programs;
- replace React and Zustand mutation Promise flows with runtime-owned Effects;
- keep only exact Electron, DOM, React, and Ink host callback shapes in the
  exemption registry.

### Stage 4: Development and test surfaces

- convert build, generator, agent-sync, packaging, and maintenance scripts to
  NodeRuntime Effect programs;
- convert examples and benchmarks to Effect-returning APIs and scoped runners;
- introduce Effect-aware Vitest and Playwright adapters;
- convert test bodies, fixtures, process helpers, filesystem helpers, and timing
  control to Effect;
- remove all temporary migration exemptions.

### Stage 5: Final ratchet and certification

- require zero unapproved semantic and AST diagnostics;
- compare every grep match with the exact host-boundary inventory;
- remove stale exemptions and migration-only tooling;
- run the entire static, unit, integration, build, package, CLI, and desktop
  certification matrix;
- perform a final manual whole-tree audit against this specification.

## Testing Strategy

The audit foundation has focused RuleTester coverage for every prohibited
construct, every legitimate host signature, narrow versus broad exemptions,
stale exemptions, root and desktop project coverage, and fixer idempotence if a
fix is offered.

Each runtime migration starts with a behavioral test at the public boundary.
Clock, Crypto, Config, and filesystem services are injected in tests so time,
randomness, configuration, and failure paths are deterministic. Resource tests
must verify normal completion, typed failure, interruption, and late callback
or event delivery after closure.

Lock tests retain the existing cross-process cases and add interruption checks
around each cleanup-sensitive phase. IPC and MessagePort tests verify handler
removal, port closure, supersession, navigation, window closure, and runtime
shutdown. Test adapters themselves are covered so a rejected or interrupted
Effect reaches the host test runner correctly.

## Completion Evidence

The project is complete only when all of the following evidence exists from a
fresh current checkout:

1. `npm run effect:audit` passes root and desktop projects with zero unapproved
   diagnostics.
2. `npm run effect:grep` contains only exact registered host-boundary matches.
3. Architecture tests prove the audit is enabled, covers all first-party source
   roots, and has no broad exclusion.
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

## Delivery and Review

Implementation is divided into the stages above. Each plan task is implemented
by a fresh project `tdd-implementer` and gated by a fresh `task-reviewer`.
Critical and Important findings are handled in a consolidated fix wave and the
same gate is repeated. One `code-reviewer` inspects the complete branch before
the controller runs fresh final verification.

No parallel agent edits the tracked tree. The controller owns architecture,
planning, review adjudication, final verification, and branch completion.

## Risks

- Effect-native backend command and application-context changes may alter public
  SDK types and require coordinated consumer migration.
- Lock conversion can weaken atomicity if interruption or cleanup regions are
  chosen incorrectly.
- Port and listener cleanup can introduce reconnect or navigation races.
- Over-broad diagnostics can accidentally force pure functions into Effect or
  place Effect inside the security-sensitive preload.
- Effect v4 and its language tooling are version-pinned pre-release software;
  the repository must pin compatible versions and avoid unrelated upgrades.
- Whole-repository migration is large enough that passing a partial audit can be
  mistaken for completion unless the final cumulative evidence is enforced.

These risks are controlled through the functional-core boundary, exact host
exemptions, staged delivery, deterministic service injection, lifecycle tests,
and the final zero-violation ratchet.

## Non-Goals

- wrapping deterministic total functions in Effect;
- replacing React, Ink, Electron, Vitest, or Playwright host APIs;
- hiding required host Promise signatures through unsafe casts;
- forcing generator syntax where a direct Effect combinator is clearer;
- changing domain behavior, RPC contracts, presentation ownership, or user
  commands except where an API must become effectful to remove hidden effects;
- upgrading TypeScript to 7 or adopting alpha `@effect/tsgo` as part of this
  migration;
- accepting a permanent baseline of existing violations.
