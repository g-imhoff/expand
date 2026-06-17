import { CliError, CliOutput } from "effect/unstable/cli"
import { makeEnvelope } from "@yodea/cli/errors/envelope"
import type { ErrorEnvelope } from "@yodea/contracts/cli"

const cliErrorToEnvelope = (e: CliError.CliError): ErrorEnvelope => {
  switch (e._tag) {
    case "InvalidValue":
    case "MissingArgument":
      return makeEnvelope("INVALID_ARGUMENT", e.message, false)
    case "MissingOption":
    case "UnrecognizedOption":
    case "DuplicateOption":
      return makeEnvelope("INVALID_OPTION", e.message, false)
    case "UnknownSubcommand":
      return makeEnvelope("UNKNOWN_COMMAND", e.message, false)
    default:
      return makeEnvelope("INVALID_ARGUMENT", e.message, false)
  }
}

export const jsonCliErrorFormatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter(),
  formatCliError: (e) => JSON.stringify(cliErrorToEnvelope(e)),
  formatError: (e) => JSON.stringify(cliErrorToEnvelope(e)),
  formatErrors: (errors) => errors.map((e) => JSON.stringify(cliErrorToEnvelope(e))).join("\n")
}
