import { Schema } from "effect"

export const ENVELOPE_VERSION = "expand/v1" as const

export const ErrorCode = Schema.Literals([
  "UNEXPECTED",
  "INVALID_ARGUMENT",
  "INVALID_OPTION",
  "UNKNOWN_COMMAND",
  "PROJECT_EXISTS",
  "BACKEND_UNREACHABLE",
  "PROJECT_NOT_FOUND",
  "NAME_CONFLICT",
  "DIRECTORY_INVALID",
  "DIRECTORY_CONFLICT"
])
