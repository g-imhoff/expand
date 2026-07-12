import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { AppContext, defaultDataDir, makeAppContext } from "@expand/contracts/app-context"

describe("AppContext", () => {
  it("exposes the channel-specific default directory", () => {
    expect(defaultDataDir()).toBe(join(homedir(), ".expand", "expand-dev"))
  })

  it("derives every path from an explicit production directory", () => {
    expect(makeAppContext("/tmp/expand-agent-data")).toEqual({
      channel: "dev",
      paths: {
        dataDir: "/tmp/expand-agent-data",
        dbPath: "/tmp/expand-agent-data/events.db",
        endpointFile: "/tmp/expand-agent-data/server.json",
        logDir: "/tmp/expand-agent-data/logs",
        spawnLockFile: "/tmp/expand-agent-data/server.json.lock"
      }
    })
  })

  it.each([
    ["dev", "expand-dev.spawn.lock"],
    ["release", "expand.spawn.lock"]
  ] as const)("derives the external %s spawn lock for the implicit default root", (selectedChannel, lockName) => {
    expect(makeAppContext(undefined, selectedChannel).paths.spawnLockFile).toBe(
      join(homedir(), ".expand-locks", lockName)
    )
  })

  it.each([
    ["dev", "expand-dev.spawn.lock"],
    ["release", "expand.spawn.lock"]
  ] as const)("derives the external %s spawn lock for an explicit equal default root", (selectedChannel, lockName) => {
    expect(makeAppContext(defaultDataDir(selectedChannel), selectedChannel).paths.spawnLockFile).toBe(
      join(homedir(), ".expand-locks", lockName)
    )
  })

  it("normalizes a relative production directory", () => {
    expect(makeAppContext("relative-state").paths.dataDir).toBe(resolve("relative-state"))
  })

  it("preserves the default when no explicit directory is provided", () => {
    expect(makeAppContext().paths.dataDir).toBe(defaultDataDir())
  })

  it("resolves the channel base under ~/.expand by default", async () => {
    const ctx = await Effect.gen(function* () {
      return yield* AppContext
    }).pipe(Effect.runPromise)
    expect(ctx.paths.dataDir).toBe(defaultDataDir())
  })
})
