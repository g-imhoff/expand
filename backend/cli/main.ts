import { Command } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { healthCommand } from "@yodea/cli/commands/health"
import { projectCommand } from "@yodea/cli/commands/project"
import { serverCommand } from "@yodea/cli/commands/server"

const yodea = Command.make("yodea", {}, () =>
  Console.log("yodea — run `yodea --help`")
).pipe(Command.withSubcommands([serverCommand, healthCommand, projectCommand]))

// Command.run reads argv from Stdio itself — do NOT pass process.argv.
Command.run(yodea, { version: "0.0.0" }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
