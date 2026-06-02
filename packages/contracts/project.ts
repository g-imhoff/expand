import { Effect, Schema } from "effect"

// Validated project name (parse-time validation in the CLI; fail fast).
export const ProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/))
)
export type ProjectName = typeof ProjectName.Type

// A project id on the wire/CLI parse layer: a v4 UUID. (Storage keeps plain
// String for compat; this is the validated parse type used by the CLI/RPC.)
export const ProjectId = Schema.String.pipe(Schema.check(Schema.isUUID(4)))
export type ProjectId = typeof ProjectId.Type

// A project tag: kebab-case, reusing the ProjectName pattern.
export const Tag = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)))
export type Tag = typeof Tag.Type

export const DESCRIPTION_MAX_LENGTH = 2048

// The Project read-model. New fields use `withDecodingDefaultKey` so old
// persisted/snapshot JSON without them still decodes (keeps yodea/v1 additive).
// NOTE: the v4 beta `withDecodingDefaultKey` takes an Effect default value (not a
// thunk) — the plan's `() => null` is spelled `Effect.succeed(null)` here.
export const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  directory: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  description: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  tags: Schema.Array(Tag).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  archived: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: Schema.String,
  // Backward-compatible; the live fold always sets it. Where "" appears, callers
  // treat it as == createdAt.
  updatedAt: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
})
export type Project = typeof Project.Type

export const ProjectCreateResult = Schema.Struct({ created: Schema.Boolean, project: Project })
export type ProjectCreateResult = typeof ProjectCreateResult.Type

export const ProjectDeleteResult = Schema.Struct({ id: Schema.String, deleted: Schema.Boolean })
export type ProjectDeleteResult = typeof ProjectDeleteResult.Type
