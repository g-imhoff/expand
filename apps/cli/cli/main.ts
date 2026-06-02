import { Command, GlobalFlag, CliOutput } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { bunAdapter } from "@yodea/client-core/adapters/bun"
import { YodeaClient, YodeaClientLive } from "@yodea/client-core"
import { Format, Quiet } from "@yodea/cli/global-flags"
import { jsonCliErrorFormatter } from "@yodea/cli/errors"
import { renderErrors } from "@yodea/cli/run"
import { healthCommand } from "@yodea/cli/commands/health"
import { projectCommand } from "@yodea/cli/commands/project"
import { serverCommand } from "@yodea/cli/commands/server"

// Build the command tree, providing the YodeaClient layer to the CLIENT commands
// only — NOT `server`, which boots the backend in-process and must never connect
// to one. Parameterized so tests inject a stub layer (mirrors production exactly).
export const makeYodea = <E, R>(clientLayer: Layer.Layer<YodeaClient, E, R>) => {
  const health = healthCommand.pipe(Command.provide(clientLayer))
  const project = projectCommand.pipe(Command.provide(clientLayer))
  return Command.make("yodea").pipe(
    Command.withDescription("Yodea — agent-first project CLI"),
    Command.withSubcommands([serverCommand, health, project]),
    Command.withGlobalFlags([Format, Quiet, ...GlobalFlag.BuiltIns])
  )
}

export const yodea = makeYodea(YodeaClientLive(bunAdapter))

// Executable entry only — importing this module (e.g. the contract test importing
// makeYodea) must NOT launch the CLI.
if (import.meta.main) {
  renderErrors(Command.run(yodea, { version: "0.0.0" })).pipe(
    Effect.provide(CliOutput.layer(jsonCliErrorFormatter)),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain
  )
}
