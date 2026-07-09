# `@expand/client-ts` examples

Runnable, real-world programs that use `@expand/client-ts` as an **external
consumer** would: every import comes from the package's public entrypoints only —
`@expand/client-ts` (the connection core), `@expand/client-ts/project` (the
project domain), and `@expand/client-ts/adapters/bun`. Contract types (`Project`,
error tags, `SequencedEvent`, …) are re-exported from those entrypoints, so no
example ever deep-imports a package internal or `@expand/contracts` directly. A deep import into a client-ts internal fails the `depcruise`
`client-ts-barrel-only` rule, which now covers this directory.

Each example builds its runtime from the shared adapter in
[`adapter.ts`](./adapter.ts) — the one bit of setup a real consumer writes once:
how to locate and spawn the backend (`resolveBackendCommand` + `makeBunAdapter`).

## Running

```sh
bun run examples/client-ts/<name>.ts <args...>
```

Pass `--data-dir <dir>` to point the client (and the backend it spawns) at an
isolated data directory instead of the real `~/.expand`; the smoke tests use a
fresh temp dir per run for exactly this reason.

## Examples

- **[`bootstrap-projects.ts`](./bootstrap-projects.ts)** — create an Expand project
  for each subfolder of a given directory, deduping against existing projects and
  skipping conflicts. Prints `bootstrap: created <N>, skipped <M>`.
  Run: `bun run examples/client-ts/bootstrap-projects.ts <dir>`
- **[`archive-stale.ts`](./archive-stale.ts)** — list the active projects and archive
  any whose `directory` no longer exists on disk. Prints
  `archive-stale: archived <N> of <M> active`.
  Run: `bun run examples/client-ts/archive-stale.ts`
- **[`audit-log.ts`](./audit-log.ts)** — tail the store's change stream and append every
  project mutation to a JSONL file (`{ seq, tag, projectId, at }` per line); runs until
  interrupted (SIGINT).
  Run: `bun run examples/client-ts/audit-log.ts <outfile>`

Each example has a subprocess smoke test in [`test/`](./test) that runs it
against an isolated backend and asserts its output, so an API change that breaks
an example fails CI.

## Findings

Writing these against the public surface is a dogfooding exercise: the payoff is
[`ERGONOMICS.md`](./ERGONOMICS.md), a set of concrete, file-referenced notes on
what felt awkward to build with — which command surface to pick and why,
boilerplate the SDK doesn't yet absorb, and where the "public API only" promise
leaks. It feeds a future ergonomics pass.
