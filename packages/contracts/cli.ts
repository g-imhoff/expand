import { Schema } from "effect"
import { Project, ProjectDeleteResult } from "@yodea/contracts/project"

// The agent-facing contract version. Bump ONLY on a breaking change to any
// envelope shape (the snapshot test guards this).
export const API_VERSION = "yodea/v1" as const

// Active error codes — frozen as part of yodea/v1; growth is additive only.
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
export type ErrorCode = typeof ErrorCode.Type

export const ErrorEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(API_VERSION),
  kind: Schema.Literal("Error"),
  code: ErrorCode,
  message: Schema.String,
  input: Schema.optional(Schema.Unknown),
  hint: Schema.optional(Schema.String),
  retryable: Schema.Boolean
})
export type ErrorEnvelope = typeof ErrorEnvelope.Type

export const ProjectEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(API_VERSION),
  kind: Schema.Literal("Project"),
  created: Schema.Boolean,
  data: Project
})
export type ProjectEnvelope = typeof ProjectEnvelope.Type

export const ProjectListEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(API_VERSION),
  kind: Schema.Literal("ProjectList"),
  count: Schema.Number,
  data: Schema.Array(Project)
})
export type ProjectListEnvelope = typeof ProjectListEnvelope.Type

export const ProjectDeleteEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(API_VERSION),
  kind: Schema.Literal("ProjectDelete"),
  data: ProjectDeleteResult
})
export type ProjectDeleteEnvelope = typeof ProjectDeleteEnvelope.Type

export const HealthEnvelope = Schema.Struct({
  apiVersion: Schema.Literal(API_VERSION),
  kind: Schema.Literal("Health"),
  data: Schema.Struct({ status: Schema.String })
})
export type HealthEnvelope = typeof HealthEnvelope.Type
