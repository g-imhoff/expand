import { describe, expect, it } from "vitest"
import { Effect, FileSystem } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateDefaultHome } from "@expand/server/migrate-default-home"

const run = (effect: Effect.Effect<void, never, FileSystem.FileSystem>) =>
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
})
