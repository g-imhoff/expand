import { Command, GlobalFlag, CliOutput } from "effect/unstable/cli"
import { makeNodeAdapter, ProcessServices } from "@expand/client-ts/adapters/node"
import { Effect, Layer, Path, type FileSystem } from "effect"
import { NodePath, NodeRuntime } from "@effect/platform-node"
import { ClientLayer, resolveBackendCommand, type BackendCommandError } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { DataDir, Format, Quiet } from "@expand/cli/global-flags"
import { jsonCliErrorFormatter } from "@expand/cli/errors"
import { renderErrors } from "@expand/cli/run"
import { healthCommand } from "@expand/cli/commands/health"
import { projectCommand } from "@expand/cli/commands/project"
import { appContextFromDataDir } from "@expand/cli/app-context-layer"

export const makeExpand = <E, R>(clientLayer: Layer.Layer<ProjectClient | ServerClient, E, R>) => {
  const configuredClientLayer = clientLayer.pipe(Layer.provide(appContextFromDataDir))
  const health = healthCommand.pipe(
    Command.withDescription("check that a Expand backend is reachable (auto-spawns one if needed)"),
    Command.provide(configuredClientLayer)
  )
  const project = projectCommand.pipe(Command.provide(configuredClientLayer))
  return Command.make("expand").pipe(
    Command.withDescription("Expand — agent-first project CLI"),
    Command.withSubcommands([health, project]),
    Command.withGlobalFlags([DataDir, Format, Quiet, ...GlobalFlag.BuiltIns])
  )
}

export const backendCommand: (
  moduleUrl?: URL
) => Effect.Effect<ReadonlyArray<string>, BackendCommandError, FileSystem.FileSystem> = Effect.fn("Cli.backendCommand")(
  function*(moduleUrl: URL = new URL(import.meta.url)) {
    const path = yield* Path.Path
    const modulePath = yield* path.fromFileUrl(moduleUrl).pipe(Effect.orDie)
    return yield* resolveBackendCommand({
      execPath: process.execPath,
      runtimeArgs: ["--import", "tsx"],
      sourceEntry: path.join(modulePath, "..", "..", "..", "server", "main.ts"),
      binaryArgs: [process.execPath, path.join(path.dirname(modulePath), "expand-server")]
    })
  },
  Effect.provide(NodePath.layer)
)

export const expand = makeExpand(ClientLayer(makeNodeAdapter({ backendCommand: backendCommand() })))

if (import.meta.main) {
  renderErrors(Command.run(expand, { version: "0.0.0" })).pipe(
    Effect.provide(CliOutput.layer(jsonCliErrorFormatter)),
    Effect.provide(ProcessServices.layer),
    NodeRuntime.runMain
  )
}
