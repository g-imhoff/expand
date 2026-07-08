import { mapProjectError, type ProjectCliError } from "@expand/cli/errors/project-errors"
import { mapServerError, mapUnexpectedError, type ServerCliError } from "@expand/cli/errors/server-errors"

export { jsonCliErrorFormatter } from "@expand/cli/errors/parser-errors"

export type ExpandCliError = ProjectCliError | ServerCliError

export const mapContractError = (e: unknown): ExpandCliError =>
  mapProjectError(e) ?? mapServerError(e) ?? mapUnexpectedError(e)
