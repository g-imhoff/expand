import { Command, GlobalFlag, CliOutput } from "effect/unstable/cli"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeBunAdapter } from "@expand/client-core/adapters/bun"
import { ClientLayer, ProjectClient, ServerClient } from "@expand/client-core"
import { Format, Quiet } from "@expand/cli/global-flags"
import { jsonCliErrorFormatter } from "@expand/cli/errors"
import { renderErrors } from "@expand/cli/run"
import { healthCommand } from "@expand/cli/commands/health"
import { projectCommand } from "@expand/cli/commands/project"
const backendCommand = (): ReadonlyArray<string> => {
  const override = process.env.EXPAND_BACKEND_CMD
  if (override) {
    const parsed = JSON.parse(override) as ReadonlyArray<string>
    if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
      throw new Error("EXPAND_BACKEND_CMD must be a JSON array of strings")
    }
    return parsed
  }
  const entry = fileURLToPath(import.meta.url)
  if (/\.(ts|js|mjs|cjs)$/.test(entry)) {
    return [process.execPath, join(entry, "..", "..", "..", "server", "main.ts")]
  }
  return [join(dirname(process.execPath), "expand-server")]
}

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

if (import.meta.main) {
  renderErrors(Command.run(expand, { version: "0.0.0" })).pipe(
    Effect.provide(CliOutput.layer(jsonCliErrorFormatter)),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain
  )
}
