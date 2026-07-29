import { resolveBackendCommand } from "@expand/client-ts"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { Effect, Path } from "effect"
export { clientLayer } from "./client-layer"

export const backendCommand = Effect.fn("ClientExample.backendCommand")(function*() {
  const path = yield* Path.Path
  const modulePath = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(Effect.orDie)
  const exampleDirectory = path.dirname(modulePath)
  return yield* resolveBackendCommand({
    execPath: "node",
    runtimeArgs: ["--import", "tsx"],
    sourceEntry: path.resolve(exampleDirectory, "..", "..", "apps", "server", "main.ts"),
    binaryArgs: [path.join(exampleDirectory, "expand-server")]
  })
}, Effect.provide(Path.layer))

export const adapter = makeNodeAdapter({ backendCommand: backendCommand() })
