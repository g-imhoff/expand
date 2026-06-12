import { Schema } from "effect"
import { Project, ProjectDeleteResult } from "@yodea/contracts/project"

export const API_VERSION = "yodea/v1" as const

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

export class ErrorEnvelope extends Schema.Opaque<ErrorEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(API_VERSION),
    kind: Schema.Literal("Error"),
    code: ErrorCode,
    message: Schema.String,
    input: Schema.optional(Schema.Unknown),
    hint: Schema.optional(Schema.String),
    retryable: Schema.Boolean
  })
) {}

export class ProjectEnvelope extends Schema.Opaque<ProjectEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(API_VERSION),
    kind: Schema.Literal("Project"),
    created: Schema.Boolean,
    data: Project
  })
) {}

export class ProjectListEnvelope extends Schema.Opaque<ProjectListEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(API_VERSION),
    kind: Schema.Literal("ProjectList"),
    count: Schema.Number,
    data: Schema.Array(Project)
  })
) {}

export class ProjectDeleteEnvelope extends Schema.Opaque<ProjectDeleteEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(API_VERSION),
    kind: Schema.Literal("ProjectDelete"),
    data: ProjectDeleteResult
  })
) {}

export class HealthEnvelope extends Schema.Opaque<HealthEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(API_VERSION),
    kind: Schema.Literal("Health"),
    data: Schema.Struct({ status: Schema.String })
  })
) {}
