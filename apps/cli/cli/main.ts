import { Command, GlobalFlag, CliOutput } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeBunAdapter } from "@expand/client-ts/adapters/bun"
import { ClientLayer, resolveBackendCommand } from "@expand/client-ts"
import { ProjectClient } from "@expand/client-ts/project"
import { ServerClient } from "@expand/client-ts/server"
import { Format, Quiet } from "@expand/cli/global-flags"
import { jsonCliErrorFormatter } from "@expand/cli/errors"
import { renderErrors } from "@expand/cli/run"
import { healthCommand } from "@expand/cli/commands/health"
import { projectCommand } from "@expand/cli/commands/project"

export const makeExpand = <E, R>(clientLayer: Layer.Layer<ProjectClient | ServerClient, E, R>) => {
  const health = healthCommand.pipe(
    Command.withDescription("check that a Expand backend is reachable (auto-spawns one if needed)"),
    Command.provide(clientLayer)
  )
  const project = projectCommand.pipe(Command.provide(clientLayer))
  return Command.make("expand").pipe(
    Command.withDescription("Expand — agent-first project CLI"),
    Command.withSubcommands([health, project]),
    Command.withGlobalFlags([Format, Quiet, ...GlobalFlag.BuiltIns])
  )
}

export const expand = makeExpand(ClientLayer(makeBunAdapter({ backendCommand })))

// From source (apps/cli/cli/main.ts) the sibling apps/server/main.ts exists →
// `bun apps/server/main.ts`; from the compiled binary it does not → the
// packaged `expand-server` next to the executable.
function backendCommand(): ReadonlyArray<string> {
  return resolveBackendCommand({
    sourceEntry: join(fileURLToPath(import.meta.url), "..", "..", "..", "server", "main.ts"),
    binaryArgs: [join(dirname(process.execPath), "expand-server")]
  })
}

if (import.meta.main) {
  renderErrors(Command.run(expand, { version: "0.0.0" })).pipe(
    Effect.provide(CliOutput.layer(jsonCliErrorFormatter)),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain
  )
}
