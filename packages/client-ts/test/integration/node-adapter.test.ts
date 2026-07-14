import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { Effect, Layer } from "effect"
import { ProcessServices } from "../process-services"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { it as effectIt } from "@effect/vitest"
import { ProjectClient, ProjectClientLayer } from "../../project/client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl } from "@expand/contracts/process-control"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expand-node-"))
})
afterEach(() => {
  vi.restoreAllMocks()
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
          Layer.provide(ProcessServices.layer),
          Layer.provide(Layer.succeed(AppContext, makeTestAppContext(dir)))
        )
      )
    )
  })

  effectIt("captures the current pid when the layer is acquired", () => {
    vi.spyOn(process, "pid", "get").mockReturnValue(205)
    return ProcessControl.pipe(
      Effect.provide(ProcessServices.processControlLayer),
      Effect.tap((control) => Effect.sync(() => expect(control.currentPid).toBe(205)))
    )
  })

  effectIt("maps a successful zero-signal probe to alive", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true)

    return probe(201).pipe(
      Effect.tap((status) => Effect.sync(() => {
        expect(status).toBe("alive")
        expect(kill).toHaveBeenCalledWith(201, 0)
      }))
    )
  })

  effectIt("maps ESRCH to dead", () => {
    const cause = Object.assign(new Error("missing process"), { code: "ESRCH" })
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw cause
    })

    return probe(202).pipe(
      Effect.tap((status) => Effect.sync(() => expect(status).toBe("dead")))
    )
  })

  effectIt("maps EPERM to inaccessible", () => {
    const cause = Object.assign(new Error("permission denied"), { code: "EPERM" })
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw cause
    })

    return probe(203).pipe(
      Effect.tap((status) => Effect.sync(() => expect(status).toBe("inaccessible")))
    )
  })

  effectIt("preserves unknown probe failures", () => {
    const cause = Object.assign(new Error("unexpected probe failure"), { code: "EIO" })
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw cause
    })

    return probe(204).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toMatchObject({ _tag: "ProcessProbeError", pid: 204, cause })
      }))
    )
  })
})

const probe = (pid: number) =>
  ProcessControl.pipe(
    Effect.flatMap((control) => control.probe(pid)),
    Effect.provide(ProcessServices.processControlLayer)
  )

const makeTestAppContext = (dataDir: string) =>
  makeAppContext(
    { join, resolve },
    { homeDir: dataDir, cwd: dataDir, dataDir }
  )

function join(...paths: ReadonlyArray<string>): string {
  return resolve(...paths)
}
