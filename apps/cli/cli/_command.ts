import { Command } from "effect/unstable/cli"
import { Effect } from "effect"
import { Format, Quiet } from "@yodea/cli/global-flags"
import { successLine, writeOut } from "@yodea/cli/output"

export interface ResultSpec<R> {
  readonly kind: "Project" | "ProjectList" | "Health"
  readonly envelope: (r: R) => object
  readonly text: (r: R) => string
  readonly quiet: (r: R) => string
}

// Renders SUCCESS to stdout per --format/--quiet. Errors propagate UNCAUGHT to the
// top-level renderErrors seam (run.ts), which renders handler-domain AND
// layer-acquisition failures in one place.
export const defineCommand = <const Name extends string, Config extends Command.Command.Config, R, E, Deps>(
  name: Name,
  config: Config,
  result: ResultSpec<R>,
  run: (input: Command.Command.Config.Infer<Config>) => Effect.Effect<R, E, Deps>
) =>
  Command.make(name, config, (input: Command.Command.Config.Infer<Config>) =>
    Effect.gen(function* () {
      const format = yield* Format
      const quiet = yield* Quiet
      const value = yield* run(input)
      yield* writeOut(successLine({ format, quiet }, {
        envelope: result.envelope(value),
        text: result.text(value),
        quiet: result.quiet(value)
      }))
    })
  )
