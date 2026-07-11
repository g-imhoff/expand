import { describe, expect, it } from "vitest"
import { Effect, FileSystem, Logger } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { migrateLegacyHome } from "@expand/server/migrate-legacy-home"

const run = (eff: Effect.Effect<void, never, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(eff, BunFileSystem.layer))

const captureLogger = (entries: Array<string>) =>
  Logger.make(({ message }) => {
    const parts = Array.isArray(message) ? message : [message]
    entries.push(parts.map(String).join(" "))
  })

const runWithLogs = (eff: Effect.Effect<void, never, FileSystem.FileSystem>, entries: Array<string>) =>
  Effect.runPromise(eff.pipe(Effect.provide(Logger.layer([captureLogger(entries)])), Effect.provide(BunFileSystem.layer)))

const runWithFailingRename = (
  eff: Effect.Effect<void, never, FileSystem.FileSystem>,
  entries: Array<string>,
  from: string,
  to: string,
  missing: string
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        rename: (oldPath, newPath) => oldPath === from && newPath === to
          ? fs.rename(missing, newPath)
          : fs.rename(oldPath, newPath)
      })
      yield* eff.pipe(Effect.provideService(FileSystem.FileSystem, failingFs))
    }).pipe(Effect.provide(Logger.layer([captureLogger(entries)])), Effect.provide(BunFileSystem.layer))
  )

describe("migrateLegacyHome", () => {
  it("moves a legacy parent into its absent nested target", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    mkdirSync(join(legacy, "logs"), { recursive: true })
    writeFileSync(join(legacy, "events.db"), "legacy-db")
    writeFileSync(join(legacy, "marker"), "legacy")

    try {
      await run(migrateLegacyHome(target, legacy))

      expect(existsSync(join(target, "events.db"))).toBe(true)
      expect(existsSync(join(target, "marker"))).toBe(true)
      expect(existsSync(join(legacy, "events.db"))).toBe(false)
      expect(existsSync(stage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("normalizes a trailing slash before staging a direct-child migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const legacyWithSlash = `${legacy}${sep}`
    const target = join(legacy, "expand-dev")
    const stage = `${resolve(legacy)}.migrating-expand-dev`
    const nestedStage = join(legacy, ".migrating-expand-dev")
    mkdirSync(legacy)
    writeFileSync(join(legacy, "events.db"), "legacy-db")
    writeFileSync(join(legacy, "marker"), "legacy")

    try {
      await run(migrateLegacyHome(target, legacyWithSlash))

      expect(existsSync(join(target, "events.db"))).toBe(true)
      expect(existsSync(join(target, "marker"))).toBe(true)
      expect(existsSync(stage)).toBe(false)
      expect(existsSync(nestedStage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("warns without staging a deeper descendant target", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "channels", "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    const entries: Array<string> = []
    mkdirSync(legacy)
    writeFileSync(join(legacy, "events.db"), "legacy-db")
    writeFileSync(join(legacy, "marker"), "legacy")

    try {
      await runWithLogs(migrateLegacyHome(target, legacy), entries)

      expect(existsSync(join(legacy, "events.db"))).toBe(true)
      expect(existsSync(join(legacy, "marker"))).toBe(true)
      expect(existsSync(join(legacy, "channels"))).toBe(false)
      expect(existsSync(stage)).toBe(false)
      expect(entries.some((entry) => entry.includes("direct child"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves a nested legacy layout without a root event store untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    mkdirSync(legacy)
    writeFileSync(join(legacy, "marker"), "legacy")

    try {
      await run(migrateLegacyHome(target, legacy))

      expect(existsSync(join(legacy, "marker"))).toBe(true)
      expect(existsSync(target)).toBe(false)
      expect(existsSync(stage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("warns and leaves an ambiguous nested legacy layout untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    const entries: Array<string> = []
    mkdirSync(join(legacy, "logs"), { recursive: true })
    mkdirSync(join(legacy, "other-channel"))
    writeFileSync(join(legacy, "events.db"), "legacy-db")

    try {
      await runWithLogs(migrateLegacyHome(target, legacy), entries)

      expect(existsSync(join(legacy, "events.db"))).toBe(true)
      expect(existsSync(join(legacy, "other-channel"))).toBe(true)
      expect(existsSync(target)).toBe(false)
      expect(existsSync(stage)).toBe(false)
      expect(entries.some((entry) => entry.includes("ambiguous") && entry.includes(stage))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resumes a staged nested migration when the legacy parent is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    mkdirSync(stage)
    writeFileSync(join(stage, "events.db"), "legacy-db")
    writeFileSync(join(stage, "marker"), "staged")

    try {
      await run(migrateLegacyHome(target, legacy))

      expect(existsSync(join(target, "events.db"))).toBe(true)
      expect(existsSync(join(target, "marker"))).toBe(true)
      expect(existsSync(stage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resumes a staged nested migration through an empty recreated parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    mkdirSync(legacy)
    mkdirSync(stage)
    writeFileSync(join(stage, "events.db"), "legacy-db")
    writeFileSync(join(stage, "marker"), "staged")

    try {
      await run(migrateLegacyHome(target, legacy))

      expect(existsSync(join(target, "events.db"))).toBe(true)
      expect(existsSync(join(target, "marker"))).toBe(true)
      expect(existsSync(stage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("warns and preserves staged and non-empty legacy data", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    const entries: Array<string> = []
    mkdirSync(legacy)
    mkdirSync(stage)
    writeFileSync(join(legacy, "new-marker"), "new")
    writeFileSync(join(stage, "events.db"), "legacy-db")

    try {
      await runWithLogs(migrateLegacyHome(target, legacy), entries)

      expect(existsSync(join(legacy, "new-marker"))).toBe(true)
      expect(existsSync(join(stage, "events.db"))).toBe(true)
      expect(existsSync(target)).toBe(false)
      expect(entries.some((entry) => entry.includes("non-empty") && entry.includes(stage))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps recoverable staged data and reports its path after a failed move", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    const entries: Array<string> = []
    mkdirSync(legacy)
    writeFileSync(join(legacy, "events.db"), "legacy-db")
    writeFileSync(join(legacy, "marker"), "legacy")

    try {
      await runWithFailingRename(
        migrateLegacyHome(target, legacy),
        entries,
        stage,
        target,
        join(root, "missing-stage")
      )

      expect(existsSync(join(stage, "events.db"))).toBe(true)
      expect(existsSync(join(stage, "marker"))).toBe(true)
      expect(existsSync(target)).toBe(false)
      expect(entries.some((entry) => entry.includes(stage))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("uses path segments to recognize a nested target", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, "legacy")
    const target = join(legacy, "..channel")
    const stage = `${legacy}.migrating-..channel`
    mkdirSync(legacy)
    writeFileSync(join(legacy, "events.db"), "legacy-db")

    try {
      await run(migrateLegacyHome(target, legacy))

      expect(existsSync(join(target, "events.db"))).toBe(true)
      expect(existsSync(join(legacy, "events.db"))).toBe(false)
      expect(existsSync(stage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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

  it("does nothing for an absent sibling legacy directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, "legacy")
    const targetParent = join(root, "new")
    const target = join(targetParent, "expand-dev")
    const entries: Array<string> = []

    try {
      await runWithLogs(migrateLegacyHome(target, legacy), entries)

      expect(existsSync(targetParent)).toBe(false)
      expect(entries).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not merge or overwrite an existing nested target", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, ".expand")
    const target = join(legacy, "expand-dev")
    const stage = `${legacy}.migrating-expand-dev`
    mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, "events.db"), "legacy")
    writeFileSync(join(target, "events.db"), "target")

    try {
      await run(migrateLegacyHome(target, legacy))

      expect(await Bun.file(join(legacy, "events.db")).text()).toBe("legacy")
      expect(await Bun.file(join(target, "events.db")).text()).toBe("target")
      expect(existsSync(stage)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("is a no-op when the target already exists (e.g. a test temp dir)", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-mig-"))
    const legacy = join(root, "legacy")
    const target = join(root, "target")
    mkdirSync(legacy, { recursive: true }); mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, "events.db"), "legacy")
    writeFileSync(join(target, "events.db"), "target")

    await run(migrateLegacyHome(target, legacy))

    expect(await Bun.file(join(legacy, "events.db")).text()).toBe("legacy")
    expect(await Bun.file(join(target, "events.db")).text()).toBe("target")
    rmSync(root, { recursive: true, force: true })
  })
})
