import { NodeServices } from "@effect/platform-node"
import { layer as effectLayer } from "@effect/vitest"
import { Context, Effect, Layer, Path } from "effect"
import { expect, vi } from "vitest"
import { makeTempDirectoryScoped } from "../../../../test/support/effect-files"
import { ProcessServices } from "../process-services"
import { ProjectClient, ProjectClientLayer } from "../../project/client"
import { makeNodeAdapter } from "../../adapters/node"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { ProcessControl } from "@expand/contracts/process-control"

class TestDirectory extends Context.Service<TestDirectory, string>()("expand/NodeAdapterTest/Directory") {}

const TestDirectoryLive = Layer.effect(
  TestDirectory,
  makeTempDirectoryScoped("expand-node-")
).pipe(Layer.provide(NodeServices.layer))

const TestLayer = Layer.mergeAll(TestDirectoryLive, NodeServices.layer)

const withRestoredMocks = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.ensuring(Effect.sync(() => vi.restoreAllMocks())))

effectLayer(TestLayer, { excludeTestServices: true })("Node adapter", (it) => {
  it.effect("spawns + connects + creates via ws transport", () =>
    Effect.gen(function*() {
      const client = yield* ProjectClient
      const created = yield* client.create({ name: "via-node", ensure: false })
      expect(created.project.name).toBe("via-node")
      const list = yield* client.list({ includeArchived: true })
      expect(list.projects.map((project) => project.name)).toContain("via-node")
    }).pipe(
      Effect.provide(
        ProjectClientLayer(makeNodeAdapter({
          backendCommand: Effect.succeed(["node", "--import", "tsx", "apps/server/main.ts"])
        })).pipe(
          Layer.provide(ProcessServices.layer),
          Layer.provide(Layer.effect(AppContext, Effect.gen(function*() {
            const path = yield* Path.Path
            return makeTestAppContext(yield* TestDirectory, path)
          })))
        )
      )
    ))

  it.effect("captures the current pid when the layer is acquired", () =>
    withRestoredMocks(Effect.suspend(() => {
      vi.spyOn(process, "pid", "get").mockReturnValue(205)
      return ProcessControl.pipe(
        Effect.provide(ProcessServices.processControlLayer),
        Effect.tap((control) => Effect.sync(() => expect(control.currentPid).toBe(205)))
      )
    })))

  it.effect("maps a successful zero-signal probe to alive", () =>
    withRestoredMocks(Effect.suspend(() => {
      const kill = vi.spyOn(process, "kill").mockReturnValue(true)
      return probe(201).pipe(
        Effect.tap((status) => Effect.sync(() => {
          expect(status).toBe("alive")
          expect(kill).toHaveBeenCalledWith(201, 0)
        }))
      )
    })))

  it.effect("maps ESRCH to dead", () =>
    withRestoredMocks(Effect.suspend(() => {
      const cause = Object.assign(new Error("missing process"), { code: "ESRCH" })
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw cause
      })
      return probe(202).pipe(
        Effect.tap((status) => Effect.sync(() => expect(status).toBe("dead")))
      )
    })))

  it.effect("maps EPERM to inaccessible", () =>
    withRestoredMocks(Effect.suspend(() => {
      const cause = Object.assign(new Error("permission denied"), { code: "EPERM" })
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw cause
      })
      return probe(203).pipe(
        Effect.tap((status) => Effect.sync(() => expect(status).toBe("inaccessible")))
      )
    })))

  it.effect("preserves unknown probe failures", () =>
    withRestoredMocks(Effect.suspend(() => {
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
    })))
})

const probe = (pid: number) =>
  ProcessControl.pipe(
    Effect.flatMap((control) => control.probe(pid)),
    Effect.provide(ProcessServices.processControlLayer)
  )

const makeTestAppContext = (dataDir: string, path: Path.Path) =>
  makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
