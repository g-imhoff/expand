import { Data, Effect, Runtime, Schema } from "effect"
import { CliError } from "effect/unstable/cli"
import { mapContractError, type ExpandCliError } from "@expand/cli/errors"
import { ErrorEnvelopeFromJson } from "@expand/cli/errors/envelope"
import { cliErrorToEnvelope } from "@expand/cli/errors/parser-errors"
import { writeErr } from "@expand/cli/output"

export const renderErrors = Effect.fn("Cli.renderErrors")(<A, R>(
  program: Effect.Effect<A, unknown, R>
): Effect.Effect<A | void, UsageExit | ExpandCliError, R> =>
  program.pipe(
    Effect.catch((e): Effect.Effect<void, UsageExit | ExpandCliError> => {
      if (typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: string })._tag === "ShowHelp") {
        return (e as CliError.ShowHelp).errors.length > 0 ? Effect.fail(new UsageExit()) : Effect.void
      }
      if (CliError.isCliError(e)) {
        return Effect.flatMap(
          Schema.encodeEffect(ErrorEnvelopeFromJson)(cliErrorToEnvelope(e)).pipe(Effect.orDie),
          (encoded) => Effect.flatMap(writeErr(encoded), () => Effect.fail(new UsageExit()))
        )
      }
      const cliErr = mapContractError(e)
      return Effect.flatMap(
        Schema.encodeEffect(ErrorEnvelopeFromJson)(cliErr.toEnvelope()).pipe(Effect.orDie),
        (encoded) => Effect.flatMap(writeErr(encoded), () => Effect.fail(cliErr))
      )
    })
  )
)

class UsageExit extends Data.TaggedError("UsageExit")<{}> {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false
}
