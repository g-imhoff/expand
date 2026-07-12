import { describe, expect, it } from "vitest"
import { Effect, FileSystem } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateDefaultHome } from "@expand/server/migrate-default-home"

const run = (effect: Effect.Effect<void, unknown, FileSystem.FileSystem>) =>
  Effect.runPromise(Effect.provide(effect, BunFileSystem.layer))

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const isRunning = (child: ReturnType<typeof spawn>) => child.exitCode === null && child.signalCode === null

const waitForExit = async (child: ReturnType<typeof spawn>, milliseconds: number) => {
  if (!isRunning(child)) return
  await Promise.race([once(child, "exit"), delay(milliseconds)])
}

const releaseSurvivingChild = (child: {
  readonly stderr: { destroy: () => unknown } | null
  readonly unref: () => unknown
}) => {
  child.stderr?.destroy()
  child.unref()
}

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

  it("fails with the recoverable path when a legacy database remains unresolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-unresolved-migration-"))
    const legacyDir = join(root, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    mkdirSync(join(legacyDir, "other-channel"), { recursive: true })
    writeFileSync(join(legacyDir, "events.db"), "legacy-db")

    try {
      const result = await Effect.runPromise(
        Effect.result(migrateDefaultHome(defaultDir, { defaultDir, legacyDir })).pipe(
          Effect.provide(BunFileSystem.layer)
        )
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "DefaultHomeMigrationError",
          recoverablePath: join(legacyDir, "events.db")
        }
      })
      expect(existsSync(defaultDir)).toBe(false)
      expect(existsSync(join(defaultDir, "backend.lock"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("releases process handles when a child survives bounded shutdown", () => {
    let destroyed = false
    let unreferenced = false
    const child = {
      stderr: {
        destroy: () => {
          destroyed = true
        }
      },
      unref: () => {
        unreferenced = true
      }
    }

    releaseSurvivingChild(child)

    expect(destroyed).toBe(true)
    expect(unreferenced).toBe(true)
  })

  it("migrates before the production logger acquires the default target", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-production-migration-"))
    const legacyDir = join(root, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const endpointFile = join(defaultDir, "server.json")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "events.db"), "")
    writeFileSync(join(legacyDir, "marker"), "legacy")

    const child = spawn(process.execPath, ["apps/server/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, EXPAND_LOG_LEVEL: "None" },
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(endpointFile) && isRunning(child) && Date.now() < deadline) {
        await delay(25)
      }
      if (!existsSync(endpointFile)) {
        throw new Error(
          `production server did not start: exit=${String(child.exitCode)} signal=${String(child.signalCode)} stderr=${stderr}`
        )
      }

      expect(existsSync(join(defaultDir, "marker"))).toBe(true)
      expect(existsSync(join(legacyDir, "marker"))).toBe(false)
    } finally {
      if (isRunning(child)) child.kill("SIGTERM")
      await waitForExit(child, 2_000)
      if (isRunning(child)) child.kill("SIGKILL")
      await waitForExit(child, 2_000)
      if (isRunning(child)) {
        releaseSurvivingChild(child)
        throw new Error(`production server did not stop; data preserved at ${root}`)
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it("migrates a legacy default home through ordinary source CLI auto-spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-cli-default-migration-"))
    const legacyDir = join(root, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const endpointFile = join(defaultDir, "server.json")
    const spawnLockFile = join(root, ".expand-locks", "expand-dev.spawn.lock")
    const migrationLockFile = join(root, ".expand-locks", "legacy-migration.lock")
    const backendLockFile = join(defaultDir, "backend.lock")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "events.db"), "")
    writeFileSync(join(legacyDir, "marker"), "legacy")

    const child = spawn(process.execPath, ["apps/cli/cli/main.ts", "health"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: root, EXPAND_LOG_LEVEL: "None" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    try {
      const [code, signal] = await Promise.race([
        once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
        delay(30_000).then(() => {
          throw new Error("source CLI health timed out")
        })
      ])
      expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" })
      expect(stdout).toContain("ok")

      const deadline = Date.now() + 5_000
      while (
        [endpointFile, spawnLockFile, backendLockFile, migrationLockFile].some(existsSync) &&
        Date.now() < deadline
      ) {
        await delay(25)
      }

      expect(existsSync(join(defaultDir, "events.db"))).toBe(true)
      expect(existsSync(join(defaultDir, "marker"))).toBe(true)
      expect(existsSync(join(legacyDir, "events.db"))).toBe(false)
      expect(existsSync(endpointFile)).toBe(false)
      expect(existsSync(spawnLockFile)).toBe(false)
      expect(existsSync(backendLockFile)).toBe(false)
      expect(existsSync(migrationLockFile)).toBe(false)
      expect(existsSync(`${legacyDir}.migrating-expand-dev`)).toBe(false)
    } finally {
      if (isRunning(child)) child.kill("SIGKILL")
      await waitForExit(child, 2_000)
      rmSync(root, { recursive: true, force: true })
    }
  }, 40_000)
})
