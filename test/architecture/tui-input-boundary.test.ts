import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect } from "vitest"

const read = Effect.fn("TuiInputBoundary.read")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file)
})

const walk = Effect.fn("TuiInputBoundary.walk")(function*(dir: string): Effect.fn.Return<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files: Array<string> = []
  for (const entry of yield* fs.readDirectory(dir)) {
    if (entry.startsWith(".")) continue
    const full = path.join(dir, entry)
    if (entry === "node_modules" || entry === "out" || entry === "dist" || entry === "test-results") continue
    const info = yield* fs.stat(full)
    if (info.type === "Directory") files.push(...yield* walk(full))
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full)
  }
  return files
})

const ROUTER_ADAPTER = "packages/ink-input/index.ts"

describe("TUI input boundary", () => {
  it.live("ink's useInput appears in exactly one file: the ink-input router adapter", () =>
    Effect.gen(function*() {
      const offenders: Array<string> = []
      for (const file of [...yield* walk("apps"), ...yield* walk("packages")]) {
        if (file !== ROUTER_ADAPTER && /\buseInput\b/.test(yield* read(file))) offenders.push(file)
      }
      expect(offenders, "raw useInput reintroduces the global-broadcast collision (review finding C1)").toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("ink-input is a leaf: no app, sibling package, or effect imports", () =>
    Effect.gen(function*() {
      for (const file of (yield* walk("packages/ink-input")).filter((file) => !file.includes("packages/ink-input/test"))) {
        const source = yield* read(file)
        expect(source, `${file} must not import @expand/* or effect`)
          .not.toMatch(/from\s+"(@expand\/|effect)/)
      }
    }).pipe(Effect.provide(NodeServices.layer)))

  it.live("tui input policy modules stay pure (no ink imports)", () =>
    Effect.gen(function*() {
      for (const file of yield* walk("apps/tui/input")) {
        expect(yield* read(file), `${file} must stay ink-free`).not.toMatch(/from\s+"ink"/)
      }
    }).pipe(Effect.provide(NodeServices.layer)))
})
