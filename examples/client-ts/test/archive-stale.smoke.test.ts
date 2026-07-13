import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { describe, expect, it } from "vitest"
import { makeDataDir, makeFixtureDir, runExample, spawnExample } from "./helpers"

describe("example: archive-stale", () => {
  it("archives projects whose directory is gone", async () => {
    const dataDir = makeDataDir()
    const fixture = makeFixtureDir(["gone"]) // becomes project "gone" -> <fixture>/gone
    const endpointFile = join(dataDir, "server.json")
    const endpointLockFile = `${endpointFile}.lock`
    const backendLockFile = join(dataDir, "backend.lock")
    const audit = spawnExample("audit-log.ts", [join(dataDir, "audit.jsonl")], dataDir)
    let auditRunning = true
    let shutdownBlocker: WebSocket | undefined
    try {
      await audit.waitForLine("audit-log: writing to", 30_000)
      const bootstrap = await runExample("bootstrap-projects.ts", [fixture], dataDir)
      expect(bootstrap.code, bootstrap.stderr).toBe(0)
      rmSync(fixture, { recursive: true, force: true }) // its directory is now stale

      const endpoint = JSON.parse(readFileSync(endpointFile, "utf8")) as {
        readonly token: string
        readonly url: string
      }
      shutdownBlocker = await connectWebSocket(`${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`)
      await audit.kill()
      auditRunning = false

      await waitUntil(
        () => !existsSync(endpointFile) && existsSync(backendLockFile),
        "backend shutdown overlap"
      )

      const r = await runExample("archive-stale.ts", [], dataDir)
      expect(r.code, r.stderr).toBe(0)
      expect(r.stdout).toMatch(/archive-stale: archived 1 of 1 active/)
    } finally {
      if (auditRunning) await audit.kill()
      shutdownBlocker?.close()
      await waitUntil(
        () =>
          !existsSync(endpointFile) &&
          !existsSync(endpointLockFile) &&
          !existsSync(backendLockFile),
        "backend runtime cleanup"
      )
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 45_000)
})

const connectWebSocket = async (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener("error", () => reject(new Error("shutdown blocker failed to connect")), { once: true })
    socket.addEventListener("open", () => resolve(socket), { once: true })
  })

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} was not observed before timeout`)
    await delay(10)
  }
}
