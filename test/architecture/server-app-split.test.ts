import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { describe, expect } from "vitest"

const PackageJson = Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }))

const read = Effect.fn("ServerAppSplit.read")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file)
})

describe("server app split", () => {
  it.live("has a dedicated server entrypoint outside the CLI command tree", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists("apps/server/main.ts")).toBe(true)
      expect(yield* read("apps/cli/cli/main.ts")).not.toContain("serverCommand")
      expect(yield* fs.exists("apps/cli/cli/commands/server.ts")).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("builds CLI and server as separate binaries", () =>
    Effect.gen(function*() {
      const pkg = yield* Schema.decodeUnknownEffect(PackageJson)(yield* read("package.json"))
      expect(pkg.scripts.build).toBe("tsx scripts/build.ts")
      expect(yield* read("scripts/build.ts")).toContain('["apps/cli/cli/main.ts", "dist/expand"]')
      expect(yield* read("scripts/build.ts")).toContain('["apps/server/main.ts", "dist/expand-server"]')
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("keeps the compiled-binary smoke inside cert:cli:build", () =>
    Effect.gen(function*() {
      const pkg = yield* Schema.decodeUnknownEffect(PackageJson)(yield* read("package.json"))
      expect(pkg.scripts["cert:cli:build"]).toBe("tsx scripts/binary-smoke.ts")
      expect(yield* read("scripts/binary-smoke.ts")).toContain('runCommand(root, "tsx", ["scripts/build.ts"])')
      expect(yield* read("scripts/binary-smoke.ts")).toContain("scripts/fixtures/job-control.sh")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("does not keep a dependency-cruiser exception for CLI booting backend composition", () =>
    read(".dependency-cruiser.cjs").pipe(
      Effect.tap((config) => Effect.sync(() => {
        expect(config).not.toContain("composition-only-from-server-subcommand")
        expect(config).not.toContain("apps/cli/cli/commands/server")
      })),
      Effect.provide(NodeServices.layer)
    ))
})
