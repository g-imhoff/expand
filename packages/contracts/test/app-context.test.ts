import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { AppContext } from "@yodea/contracts/app-context"
import { makeTestAppContext } from "@yodea/contracts/app-context.testkit"

describe("AppContext", () => {
  it("the testkit derives all subpaths under an explicit base", () => {
    const { ctx, paths } = makeTestAppContext("/tmp/x")
    expect(ctx.channel).toBe("dev")
    expect(paths).toEqual({
      dataDir: "/tmp/x",
      dbPath: join("/tmp/x", "events.db"),
      endpointFile: join("/tmp/x", "server.json"),
      logDir: join("/tmp/x", "logs")
    })
  })

  it("resolves the channel base under ~/.yodea by default, with nothing provided (channel=dev in tests)", async () => {
    const ctx = await Effect.gen(function* () {
      return yield* AppContext
    }).pipe(Effect.runPromise)
    expect(ctx.paths.dataDir).toBe(join(homedir(), ".yodea", "yodea-dev"))
  })
})
