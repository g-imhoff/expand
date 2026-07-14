import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { it as effectIt } from "@effect/vitest"
import { ProjectClient, ProjectClientLayer } from "../../project/client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-node-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Node adapter", () => {
  effectIt.live("spawns + connects + creates via ws transport", () => {
    const adapter = makeNodeAdapter({
      backendCommand: Effect.sync(() => ["node", "--import", "tsx", resolve("apps/server/main.ts")])
    })
    return Effect.gen(function*() {
      const client = yield* ProjectClient
      const created = yield* client.create({ name: "via-node", ensure: false })
      expect(created.project.name).toBe("via-node")

      const list = yield* client.list({ includeArchived: true })
      expect(list.projects.map((project) => project.name)).toContain("via-node")
    }).pipe(
      Effect.provide(
        ProjectClientLayer(adapter).pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(AppContext, makeTestAppContext(dir)))
        )
      )
    )
  })
})

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
