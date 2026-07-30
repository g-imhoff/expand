import { CliError, CliOutput } from "effect/unstable/cli"
import { Schema } from "effect"
import { ErrorEnvelopeFromJson, type ErrorEnvelope, makeEnvelope } from "@expand/cli/errors/envelope"

export const cliErrorToEnvelope = (e: CliError.CliError): ErrorEnvelope => {
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
  formatCliError: (e) => encodeErrorEnvelope(cliErrorToEnvelope(e)),
  formatError: (e) => encodeErrorEnvelope(cliErrorToEnvelope(e)),
  formatErrors: (errors) => errors.map((e) => encodeErrorEnvelope(cliErrorToEnvelope(e))).join("\n")
}

const encodeErrorEnvelope = Schema.encodeSync(ErrorEnvelopeFromJson)
