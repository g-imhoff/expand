import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { build as esbuildBuild, type BuildOptions } from "esbuild"
import { Context, Data, Effect, FileSystem, Layer, Path } from "effect"

export const BUILD_ENTRIES = [
  ["apps/cli/cli/main.ts", "dist/expand"],
  ["apps/server/main.ts", "dist/expand-server"]
] as const

const nodeModule = ["node:", "module"].join("")

export const BUILD_BANNER = `#!/usr/bin/env node\nimport { createRequire as __expandCreateRequire } from "${nodeModule}"; const require = __expandCreateRequire(import.meta.url);`

export interface BuildToolShape {
  readonly build: (options: BuildOptions) => Effect.Effect<void, unknown>
}

export class BuildTool extends Context.Service<BuildTool, BuildToolShape>()("expand/scripts/BuildTool") {}

export class BuildError extends Data.TaggedError("BuildError")<{
  readonly operation: "remove" | "mkdir" | "esbuild" | "chmod"
  readonly cause: unknown
}> {}

export const buildOptions = (rootDir: string, entry: string, outfile: string): BuildOptions => ({
  entryPoints: [entry],
  outfile,
  absWorkingDir: rootDir,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  banner: { js: BUILD_BANNER },
  define: { __EXPAND_CHANNEL__: '"release"' },
  external: ["better-sqlite3"]
})

export const buildBinaries = Effect.fn("scripts.build.buildBinaries")(
  function*(rootDir: string) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const tool = yield* BuildTool
    const dist = path.join(rootDir, "dist")

    yield* fs.remove(dist, { recursive: true, force: true }).pipe(
      Effect.mapError((cause) => new BuildError({ operation: "remove", cause }))
    )
    yield* fs.makeDirectory(dist, { recursive: true }).pipe(
      Effect.mapError((cause) => new BuildError({ operation: "mkdir", cause }))
    )

    for (const [entry, output] of BUILD_ENTRIES) {
      const outfile = path.join(rootDir, output)
      yield* tool.build(buildOptions(rootDir, path.join(rootDir, entry), outfile)).pipe(
        Effect.mapError((cause) => new BuildError({ operation: "esbuild", cause }))
      )
      yield* fs.chmod(outfile, 0o755).pipe(
        Effect.mapError((cause) => new BuildError({ operation: "chmod", cause }))
      )
    }
  }
)

const buildTool: BuildToolShape = {
  build: Effect.fn("scripts.build.buildTool")((options) => Effect.tryPromise({
    try: () => esbuildBuild(options),
    catch: (cause) => new BuildError({ operation: "esbuild", cause })
  }))
}

export const BuildToolLive = Layer.succeed(BuildTool, buildTool)

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  yield* buildBinaries(root)
}).pipe(
  Effect.provide(Layer.mergeAll(BuildToolLive, NodeServices.layer))
)

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
