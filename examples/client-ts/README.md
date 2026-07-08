# `@expand/client-ts` examples

Runnable, real-world programs that use `@expand/client-ts` as an **external
consumer** would: every import comes from the package's public surface only —
`@expand/client-ts` (the barrel) and `@expand/client-ts/adapters/bun`. Contract
types (`Project`, error tags, `SequencedEvent`, …) are re-exported from the
barrel, so no example ever deep-imports a package internal or `@expand/contracts`
directly. A deep import into a client-ts internal fails the `depcruise`
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

_(added in later tasks)_
