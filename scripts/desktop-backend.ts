import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Path } from "effect"
import { BuildToolLive, buildDesktopBackend } from "./build"

const program = Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  const appVersion = yield* Config.string("EXPAND_APP_VERSION").pipe(
    Config.withDefault("0.0.0-dev")
  )
  yield* buildDesktopBackend(root, appVersion)
}).pipe(Effect.provide(Layer.mergeAll(BuildToolLive, NodeServices.layer)))

if (import.meta.main) {
  NodeRuntime.runMain(program)
}
