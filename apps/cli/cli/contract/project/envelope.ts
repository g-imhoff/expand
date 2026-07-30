import { Schema } from "effect"
import { Project, ProjectDeleteResult } from "@expand/contracts/project"
import { ENVELOPE_VERSION } from "@expand/cli/contract/version"

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
