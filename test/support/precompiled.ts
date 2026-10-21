import { Effect } from "effect"
import { createHash } from "node:crypto"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"

/**
 * esbuild each spawned TS fixture to a stable temp `.cjs` bundle once, then
 * boot it with plain `node` instead of `node --import tsx`.
 *
 * A prior probe showed the win is entirely the per-spawn tsx transform
 * (~0.8-1s per spawn vs ~0.1s for a prebuilt bundle, same runtime and code).
 * esbuild itself is a devDependency and bundles a contender in ~200ms, so
 * each test file warms its fixtures once in `beforeAll` and every spawn
 * afterwards reuses the cached bundle via `buildFixture`.
 *
 * The cache is keyed by absolute entrypoint path and lives for the worker
 * lifetime, which covers the requesting test file. Output files are unique
 * per entrypoint (`<basename>-<sha1>.cjs` under the OS temp dir).
 */
const bundleCache = new Map<string, string>()
const bundleInflight = new Map<string, Promise<string>>()

const absoluteEntrypoint = (entrypoint: string): string =>
  NodePath.isAbsolute(entrypoint)
    ? NodePath.normalize(entrypoint)
    : NodePath.resolve(process.cwd(), entrypoint)

const bundleOutput = (absolute: string): string => {
  const hash = createHash("sha1").update(absolute).digest("hex").slice(0, 12)
  const base = NodePath.basename(absolute).replace(/[^a-zA-Z0-9_-]+/g, "_")
  return NodePath.join(NodeOs.tmpdir(), `expand-fixture-${base}-${hash}.cjs`)
}

export const bundlePathFor = (entrypoint: string): string =>
  bundleOutput(absoluteEntrypoint(entrypoint))

export const buildFixture = Effect.fn("TestSupport.buildFixture")(function*(entrypoint: string) {
  const absolute = absoluteEntrypoint(entrypoint)
  const cached = bundleCache.get(absolute)
  if (cached !== undefined) return cached
  const ongoing = bundleInflight.get(absolute)
  if (ongoing !== undefined) return yield* Effect.promise(() => ongoing)
  const output = bundleOutput(absolute)
  const pending = import("esbuild").then(({ build }) =>
    build({
      entryPoints: [absolute],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      outfile: output,
      absWorkingDir: process.cwd(),
      logLevel: "warning"
    })
  ).then(
    () => {
      bundleCache.set(absolute, output)
      bundleInflight.delete(absolute)
      return output
    },
    (cause) => {
      bundleInflight.delete(absolute)
      throw cause
    }
  )
  bundleInflight.set(absolute, pending)
  return yield* Effect.promise(() => pending)
})
