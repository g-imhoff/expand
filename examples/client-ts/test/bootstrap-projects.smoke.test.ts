import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Console, Effect, FileSystem, Layer, Path } from "effect"
import { describe, expect } from "vitest"
import type { ProjectClientApi } from "@expand/client-ts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { BootstrapInvalidInputError, BootstrapRpcError, bootstrapProjects } from "../bootstrap-projects"

const clientLayer = (client: ProjectClientApi) => Layer.succeed(ProjectClient, client)

const capturingConsole = (lines: Array<string>): Console.Console => ({
  log: (...args: ReadonlyArray<unknown>) => { lines.push(args.join(" ")) },
  error: () => undefined
} as unknown as Console.Console)

describe("example: bootstrap-projects", () => {
  it.effect("imports lazily and rejects an empty root through the typed channel", () =>
    bootstrapProjects("").pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new BootstrapInvalidInputError({ root: "" }))
      })),
      Effect.provide(Layer.mergeAll(clientLayer({} as ProjectClientApi), NodeServices.layer))
    ))

  it.effect("reports list RPC failures through the typed channel", () => {
    const client = {
      list: () => Effect.fail({ reason: "rpc" })
    } as unknown as ProjectClientApi
    return bootstrapProjects("/root").pipe(
      Effect.provide(Layer.mergeAll(FileSystem.layerNoop({ readDirectory: () => Effect.succeed([]) }), Path.layer, clientLayer(client))),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toBeInstanceOf(BootstrapRpcError)
        if (error._tag === "BootstrapRpcError") expect(error.operation).toBe("list")
      }))
    )
  })

  it.effect("creates one project per valid subfolder in deterministic order and reports the count", () =>
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "expand-fixture-" })
      yield* fs.makeDirectory(path.join(dir, "beta"))
      yield* fs.makeDirectory(path.join(dir, "alpha"))
      const created: Array<string> = []
      const lines: Array<string> = []
      const client = {
        list: () => Effect.succeed({ projects: [], seq: 0 }),
        create: ({ name }: { readonly name: string }) => Effect.sync(() => {
          created.push(name)
          return { project: {}, created: true }
        })
      } as unknown as ProjectClientApi

      yield* bootstrapProjects(dir).pipe(
        Effect.provide(clientLayer(client)),
        Effect.provideService(Console.Console, capturingConsole(lines))
      )

      expect(created).toEqual(["alpha", "beta"])
      expect(lines).toEqual(["bootstrap: created 2, skipped 0"])
    })).pipe(Effect.provide(NodeServices.layer)))   // two valid project-name dirs
})
