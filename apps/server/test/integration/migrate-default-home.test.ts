import { describe, expect, it } from "vitest"
import { Effect, FileSystem } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateDefaultHome } from "@expand/server/migrate-default-home"

const run = (effect: Effect.Effect<void, never, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(effect, BunFileSystem.layer))

describe("migrateDefaultHome", () => {
  it("migrates when the active directory is the default", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-default-migration-"))
    const legacyDir = join(root, "legacy")
    const defaultDir = join(root, "default")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "marker"), "legacy")
    try {
      await run(migrateDefaultHome(defaultDir, { defaultDir, legacyDir }))
      expect(existsSync(join(defaultDir, "marker"))).toBe(true)
      expect(existsSync(legacyDir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not migrate a legacy home into an explicit override", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-override-migration-"))
    const legacyDir = join(root, "legacy")
    const defaultDir = join(root, "default")
    const overrideDir = join(root, "override")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "marker"), "legacy")
    try {
      await run(migrateDefaultHome(overrideDir, { defaultDir, legacyDir }))
      expect(existsSync(join(legacyDir, "marker"))).toBe(true)
      expect(existsSync(overrideDir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
