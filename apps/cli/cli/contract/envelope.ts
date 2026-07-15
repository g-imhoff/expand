import { Schema } from "effect"
import { Project, ProjectDeleteResult } from "@expand/contracts/project"
import { ENVELOPE_VERSION, ErrorCode } from "./envelope-internal"

export class ErrorEnvelope extends Schema.Opaque<ErrorEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("Error"),
    code: ErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
    input: Schema.optional(Schema.Unknown),
    hint: Schema.optional(Schema.String)
  })
) {}

export class ProjectEnvelope extends Schema.Opaque<ProjectEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("Project"),
    created: Schema.Boolean,
    data: Project
  })
) {}

export class ProjectListEnvelope extends Schema.Opaque<ProjectListEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("ProjectList"),
    count: Schema.Number,
    data: Schema.Array(Project)
  })
) {}

export class ProjectDeleteEnvelope extends Schema.Opaque<ProjectDeleteEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("ProjectDelete"),
    data: ProjectDeleteResult
  })
) {}

export class HealthEnvelope extends Schema.Opaque<HealthEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("Health"),
    data: Schema.Struct({ status: Schema.String })
  })
) {}

export const ErrorEnvelopeFromJson = Schema.fromJsonString(ErrorEnvelope)

export { ENVELOPE_VERSION, ErrorCode }
export type ErrorCode = typeof ErrorCode.Type
