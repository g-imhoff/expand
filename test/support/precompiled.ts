import { Effect } from "effect"
import { createHash, randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeFsPromises from "node:fs/promises"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"

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
 *
 * Vitest workers are separate processes with separate module-level caches, so
 * parallel files would esbuild to the same stable path concurrently and a
 * cache hit could read a partially written bundle. Each build therefore
 * writes to a unique temp path (`<output>.<pid>.<rand>.tmp`) and is
 * atomically renamed over the stable path, so observers only ever see a
 * complete bundle or ENOENT. Cache hits verify the file still exists and
 * rebuild when it does not (e.g. a fresh boot after a tmpdir clear).
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

const uniqueTempOutput = (output: string): string =>
  `${output}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`

export const buildFixture = Effect.fn("TestSupport.buildFixture")(function*(entrypoint: string) {
  const absolute = absoluteEntrypoint(entrypoint)
  const cached = bundleCache.get(absolute)
  if (cached !== undefined) {
    if (NodeFs.existsSync(cached)) return cached
    bundleCache.delete(absolute)
  }
  const ongoing = bundleInflight.get(absolute)
  if (ongoing !== undefined) return yield* Effect.promise(() => ongoing)
  const output = bundleOutput(absolute)
  const tempOutput = uniqueTempOutput(output)
  const pending = import("esbuild").then(({ build }) =>
    build({
      entryPoints: [absolute],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      outfile: tempOutput,
      absWorkingDir: process.cwd(),
      logLevel: "warning"
    })
  ).then(
    () =>
      NodeFsPromises.rename(tempOutput, output).then(() => {
        bundleCache.set(absolute, output)
        bundleInflight.delete(absolute)
        return output
      }),
    (cause) =>
      NodeFsPromises.unlink(tempOutput).catch(() => undefined).then(() => {
        bundleInflight.delete(absolute)
        throw cause
      })
  )
  bundleInflight.set(absolute, pending)
  return yield* Effect.promise(() => pending)
})

/**
 * esbuild each spawned client-ts example to a stable temp `.cjs` bundle once,
 * then boot it with plain `node` instead of `node --import tsx`.
 *
 * Examples gate their entrypoint on `import.meta.main` and locate the backend
 * source entry via `import.meta.url` (in `../adapter.ts`). CJS has no
 * `import.meta`, so both are shimmed with `define`: `import.meta.main` is
 * `true` (a bundle is always the entrypoint) and `import.meta.url` is the file
 * URL of the ORIGINAL source entrypoint, so relative resolution
 * (`exampleDirectory` -> `../../apps/server/main.ts`) keeps working. The shim
 * is global to the bundle, which is sound here because every example lives in
 * the same directory as `adapter.ts` (only the dirname is ever used). ESM
 * output is not an option: bundled `ws` dynamic requires fail under ESM.
 *
 * Each example bundle was verified behaviorally identical to its tsx run in
 * scratch runs under /tmp (same stdout/exit on invalid-input runs; a full
 * backend round-trip for archive-stale, including once without the backend
 * override so the url shim resolved the tsx backend itself).
 */
const exampleCache = new Map<string, string>()
const exampleInflight = new Map<string, Promise<string>>()

const exampleOutput = (absolute: string): string => {
  const hash = createHash("sha1").update(`example:${absolute}`).digest("hex").slice(0, 12)
  const base = NodePath.basename(absolute).replace(/[^a-zA-Z0-9_-]+/g, "_")
  return NodePath.join(NodeOs.tmpdir(), `expand-example-${base}-${hash}.cjs`)
}

export const exampleBundlePathFor = (entrypoint: string): string =>
  exampleOutput(absoluteEntrypoint(entrypoint))

export const buildExample = Effect.fn("TestSupport.buildExample")(function*(entrypoint: string) {
  const absolute = absoluteEntrypoint(entrypoint)
  const cached = exampleCache.get(absolute)
  if (cached !== undefined) {
    if (NodeFs.existsSync(cached)) return cached
    exampleCache.delete(absolute)
  }
  const ongoing = exampleInflight.get(absolute)
  // tryPromise (not promise): an esbuild rejection (e.g. a missing entrypoint
  // in startup-failure tests) must be a catchable failure so spawnExample can
  // fall back to tsx, not a defect.
  if (ongoing !== undefined) return yield* Effect.tryPromise(() => ongoing)
  const output = exampleOutput(absolute)
  const tempOutput = uniqueTempOutput(output)
  const url = pathToFileURL(absolute).href
  const pending = import("esbuild").then(({ build }) =>
    build({
      entryPoints: [absolute],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      outfile: tempOutput,
      absWorkingDir: process.cwd(),
      logLevel: "warning",
      define: {
        "import.meta.url": JSON.stringify(url),
        "import.meta.main": "true"
      }
    })
  ).then(
    () =>
      NodeFsPromises.rename(tempOutput, output).then(() => {
        exampleCache.set(absolute, output)
        exampleInflight.delete(absolute)
        return output
      }),
    (cause) =>
      NodeFsPromises.unlink(tempOutput).catch(() => undefined).then(() => {
        exampleInflight.delete(absolute)
        throw cause
      })
  )
  exampleInflight.set(absolute, pending)
  return yield* Effect.tryPromise(() => pending)
})
