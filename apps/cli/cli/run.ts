import { Data, Effect, Runtime } from "effect"
import { CliError } from "effect/unstable/cli"
import { mapContractError, type ExpandCliError } from "@expand/cli/errors"
import { cliErrorToEnvelope } from "@expand/cli/errors/parser-errors"
import { writeErr } from "@expand/cli/output"

export const renderErrors = <A, R>(
  program: Effect.Effect<A, unknown, R>
): Effect.Effect<A | void, UsageExit | ExpandCliError, R> =>
  program.pipe(
    Effect.catch((e): Effect.Effect<void, UsageExit | ExpandCliError> => {
      if (typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: string })._tag === "ShowHelp") {
        return (e as CliError.ShowHelp).errors.length > 0 ? Effect.fail(new UsageExit()) : Effect.void
      }
      if (CliError.isCliError(e)) {
        return Effect.flatMap(
          writeErr(JSON.stringify(cliErrorToEnvelope(e))),
          () => Effect.fail(new UsageExit())
        )
      }
      const cliErr = mapContractError(e)
      return Effect.flatMap(writeErr(JSON.stringify(cliErr.toEnvelope())), () => Effect.fail(cliErr))
    })
  )

class UsageExit extends Data.TaggedError("UsageExit")<{}> {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false
}
