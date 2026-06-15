import { mapProjectError, type ProjectCliError } from "@yodea/cli/errors/project-errors"
import { mapServerError, mapUnexpectedError, type ServerCliError } from "@yodea/cli/errors/server-errors"

export { jsonCliErrorFormatter, cliErrorToEnvelope } from "@yodea/cli/errors/parser-errors"
export {
  ProjectExists,
  ProjectNotFoundCli,
  NameConflictCli,
  DirectoryInvalidCli,
  DirectoryConflictCli,
  InvalidInputCli,
  mapProjectError,
  type ProjectCliError
} from "@yodea/cli/errors/project-errors"
export { BackendUnreachable, Unexpected, mapServerError, mapUnexpectedError, type ServerCliError } from "@yodea/cli/errors/server-errors"

export type YodeaCliError = ProjectCliError | ServerCliError

export const mapContractError = (e: unknown): YodeaCliError =>
  mapProjectError(e) ?? mapServerError(e) ?? mapUnexpectedError(e)
