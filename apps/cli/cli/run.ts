import { Data, Effect, Runtime } from "effect"
import type { CliError } from "effect/unstable/cli"
import { mapContractError, type YodeaCliError } from "@yodea/cli/errors"
import { writeErr } from "@yodea/cli/output"

// Carries exit 2 for usage/parse failures. The CliOutput formatter already wrote
// the JSON error envelope to stderr during parsing, so this only fixes the exit
// code silently (errorReported=false => runMain won't re-log it).
export class UsageExit extends Data.TaggedError("UsageExit")<{}> {
  readonly [Runtime.errorExitCode] = 2
  readonly [Runtime.errorReported] = false
}

// THE single top-level error seam. Applied identically by main.ts and the test
// harness. Catches everything that escaped a handler:
//  - CliError.ShowHelp (parse/usage; formatter already printed JSON): with errors
//    -> exit 2; without errors (explicit --help/--version) -> success (exit 0).
//  - domain/transport errors (handler failures AND YodeaClientLive layer-acquisition
//    BackendUnavailable): map -> YodeaCliError, write JSON envelope to stderr, re-fail
//    so runMain sets the right exit code.
export const renderErrors = <A, R>(
  program: Effect.Effect<A, unknown, R>
): Effect.Effect<A | void, UsageExit | YodeaCliError, R> =>
  program.pipe(
    Effect.catch((e): Effect.Effect<void, UsageExit | YodeaCliError> => {
      if (typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: string })._tag === "ShowHelp") {
        return (e as CliError.ShowHelp).errors.length > 0 ? Effect.fail(new UsageExit()) : Effect.void
      }
      const cliErr = mapContractError(e)
      return Effect.flatMap(writeErr(JSON.stringify(cliErr.toEnvelope())), () => Effect.fail(cliErr))
    })
  )
