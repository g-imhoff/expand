import { Command } from "effect/unstable/cli"
import { Effect } from "effect"
import { Format, Quiet } from "@expand/cli/global-flags"
import { successLine, writeOut } from "@expand/cli/output"

export interface ResultSpec<R> {
  readonly envelope: (r: R) => object
  readonly text: (r: R) => string
  readonly quiet: (r: R) => string
}

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
