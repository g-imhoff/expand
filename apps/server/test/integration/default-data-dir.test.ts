import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const isRunning = (child: ReturnType<typeof spawn>) => child.exitCode === null && child.signalCode === null

const waitForExit = async (child: ReturnType<typeof spawn>, milliseconds: number) => {
  if (!isRunning(child)) return
  await Promise.race([once(child, "exit"), delay(milliseconds)])
}

describe("default data directory", () => {
  it("starts fresh without moving an old unscoped home", async () => {
    const root = mkdtempSync(join(tmpdir(), "expand-default-isolation-"))
    const legacyDir = join(root, ".expand")
    const defaultDir = join(legacyDir, "expand-dev")
    const endpointFile = join(defaultDir, "server.json")
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, "events.db"), "")
    writeFileSync(join(legacyDir, "marker"), "legacy")

    const child = spawn(process.execPath, ["--import", "tsx", "apps/server/main.ts"], {
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

      expect(existsSync(join(legacyDir, "events.db"))).toBe(true)
      expect(existsSync(join(legacyDir, "marker"))).toBe(true)
      expect(existsSync(join(defaultDir, "events.db"))).toBe(true)
      expect(existsSync(join(defaultDir, "marker"))).toBe(false)
    } finally {
      if (isRunning(child)) child.kill("SIGTERM")
      await waitForExit(child, 2_000)
      if (isRunning(child)) child.kill("SIGKILL")
      await waitForExit(child, 2_000)
      if (isRunning(child)) {
        child.stderr?.destroy()
        child.unref()
        throw new Error(`production server did not stop; data preserved at ${root}`)
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
