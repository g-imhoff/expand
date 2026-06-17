import { mapProjectError, type ProjectCliError } from "@yodea/cli/errors/project-errors"
import { mapServerError, mapUnexpectedError, type ServerCliError } from "@yodea/cli/errors/server-errors"

export { jsonCliErrorFormatter } from "@yodea/cli/errors/parser-errors"

export type YodeaCliError = ProjectCliError | ServerCliError

export const mapContractError = (e: unknown): YodeaCliError =>
  mapProjectError(e) ?? mapServerError(e) ?? mapUnexpectedError(e)
