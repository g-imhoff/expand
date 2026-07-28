import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { networkInterfaces } from "node:os"
import { Console, Effect, Layer, Path, Schema, Stdio } from "effect"
import { AppContext, makeAppContext } from "@expand/contracts/app-context"
import { runServer } from "@expand/server/composition/app"
import { ProcessServices } from "@expand/server/node-process-control"

const HostArguments = Schema.Union([
  Schema.Tuple([Schema.Literal("network-targets")]),
  Schema.Tuple([Schema.Literal("permissive-umask-server"), Schema.String])
])

const NetworkTargets = Schema.fromJsonString(Schema.Array(Schema.String))

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* Schema.decodeUnknownEffect(HostArguments)(yield* stdio.args)
  if (args[0] === "network-targets") {
    const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
      (entries ?? [])
        .filter((entry) => !entry.internal && entry.family === "IPv4")
        .map((entry) => entry.address)
    )
    const output = yield* Schema.encodeEffect(NetworkTargets)(["::1", ...addresses])
    yield* Console.log(output)
    return
  }

  const dataDir = args[1]
  process.umask(0o002)
  const path = yield* Path.Path
  const context = makeAppContext(path, { homeDir: dataDir, cwd: dataDir, dataDir })
  yield* runServer({ dbPath: path.join(dataDir, "events.db") }).pipe(
    Effect.provide(Layer.mergeAll(ProcessServices.layer, Layer.succeed(AppContext, context)))
  )
})

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(NodeServices.layer),
    Effect.orDie
  )
)
