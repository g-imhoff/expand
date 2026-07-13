import { Command, GlobalFlag, CliOutput } from "effect/unstable/cli"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeNodeAdapter } from "@expand/client-ts/adapters/node"
import { ClientLayer, resolveBackendCommand } from "@expand/client-ts"
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

export const expand = makeExpand(ClientLayer(makeNodeAdapter({ backendCommand })))

function backendCommand(): ReadonlyArray<string> {
  const sourceEntry = join(fileURLToPath(import.meta.url), "..", "..", "..", "server", "main.ts")
  return resolveBackendCommand({
    execPath: process.execPath,
    runtimeArgs: ["--import", "tsx"],
    sourceEntry,
    binaryArgs: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "expand-server")]
  })
}

if (import.meta.main) {
  renderErrors(Command.run(expand, { version: "0.0.0" })).pipe(
    Effect.provide(CliOutput.layer(jsonCliErrorFormatter)),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain
  )
}
