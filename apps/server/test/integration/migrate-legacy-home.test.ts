import { describe, expect, it } from "vitest"
import { Effect, FileSystem } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateLegacyHome } from "@expand/server/migrate-legacy-home"

const run = (eff: Effect.Effect<void, never, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(eff, BunFileSystem.layer))

describe("migrateLegacyHome", () => {
  it("moves a provided legacy dir into the target when the target is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, "legacy")
    const target = join(root, "new", "expand-dev")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "events.db"), "x")

    await run(migrateLegacyHome(target, legacy))

    expect(existsSync(join(target, "events.db"))).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it("is a no-op when the target already exists (e.g. a test temp dir)", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, "legacy")
    const target = join(root, "target")
    mkdirSync(legacy, { recursive: true }); mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, "events.db"), "x")

    await run(migrateLegacyHome(target, legacy))

    expect(existsSync(join(legacy, "events.db"))).toBe(true) // untouched
    rmSync(root, { recursive: true, force: true })
  })
})
