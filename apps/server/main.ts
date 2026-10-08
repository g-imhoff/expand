import { NodeFileSystem, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, FileSystem, Layer, Logger, Path, References, Stdio } from "effect"
import { nodeAppContextLayer } from "@expand/server/runtime/node-app-context"
import { minimumLogLevel } from "@expand/server/runtime/server-config"
import { hostFromArgs, portFromArgs, resolveServiceHost, resolveServicePort } from "@expand/server/runtime/service-config"
import * as AppContext from "@expand/contracts/app-context"
import * as ServerApp from "@expand/server/composition/app"
import * as StateRootLock from "@expand/server/runtime/state-root-lock"
import * as NodeProcessControl from "@expand/server/runtime/node-process-control"
import { appVersion } from "@expand/contracts/build-info"

const fileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { paths } = yield* AppContext.AppContext
  yield* fs.makeDirectory(paths.logDir, { recursive: true })
  return yield* Logger.formatLogFmt.pipe(Logger.toFile(path.join(paths.logDir, "server.log")))
})

const loggerLayer = Logger.layer([fileLogger], { mergeWithExisting: true }).pipe(
  Layer.provide(NodeFileSystem.layer)
)

const loggedProgram = (options: { keepRunning: boolean; host: string; port: number }) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { paths } = yield* AppContext.AppContext
  yield* fs.makeDirectory(path.dirname(paths.dbPath), { recursive: true })
  yield* ServerApp.runServer({ dbPath: paths.dbPath, keepRunning: options.keepRunning, host: options.host, port: options.port })
}).pipe(Effect.provide(loggerLayer))

const helpText = [
  "Expand backend",
  "",
  "Usage: npm run dev:server -- [options]",
  "",
  "Options:",
  "  --keep-running    Keep serving when no clients are connected. Default: stop after the last client disconnects.",
  "  --data-dir DIR    Store the database, endpoint and lock files in DIR.",
  "  --host HOST       Bind address, 127.0.0.1 or 0.0.0.0. Default: 127.0.0.1.",
  "  --port PORT       Stable port for service operation. Default: 0 (ephemeral).",
  "  --help            Show this help and exit."
].join("\n")

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.includes("--help")) {
    yield* Console.log(helpText)
    return
  }
  yield* Effect.logInfo("starting Expand server", { appVersion })
  const { paths } = yield* AppContext.AppContext
  yield* StateRootLock.stateRootLockForStartup(paths.dataDir, paths.endpointFile)
  const host = resolveServiceHost(hostFromArgs(args), globalThis.process?.env?.["EXPAND_HOST"])
  const port = resolveServicePort(portFromArgs(args), globalThis.process?.env?.["EXPAND_PORT"])
  yield* loggedProgram({ keepRunning: args.includes("--keep-running"), host, port })
}).pipe(Effect.scoped)

// Every file this process creates — the SQLite event store (+ WAL/SHM), the
// endpoint file that carries the auth token, the logs — is private to this
// user. Born-owner-only (0600 files, 0700 dirs) is the floor, so set a strict
// umask before the logger or anything else touches the filesystem.
process.umask(0o077)

NodeRuntime.runMain(
  program.pipe(
    Effect.provideServiceEffect(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(nodeAppContextLayer.pipe(
      Layer.provideMerge(NodeProcessControl.ProcessServices.layer satisfies Layer.Layer<
        NodeServices.NodeServices | import("@expand/contracts/process-control").ProcessControl
      >)
    ))
  ),
  {
    teardown: (exit, onExit) =>
      onExit(Exit.isSuccess(exit) || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) ? 0 : 1)
  }
)
