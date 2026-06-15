import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { SequencedEvent } from "@yodea/contracts/events/domain"
import { Project, ProjectCreateResult, ProjectDeleteResult } from "@yodea/contracts/project"

export class ProjectAlreadyExists extends Schema.TaggedErrorClass<ProjectAlreadyExists>()(
  "ProjectAlreadyExists",
  { name: Schema.String }
) {}

export class ProjectNotFound extends Schema.TaggedErrorClass<ProjectNotFound>()(
  "ProjectNotFound",
  { id: Schema.String }
) {}

export class ProjectNameConflict extends Schema.TaggedErrorClass<ProjectNameConflict>()(
  "ProjectNameConflict",
  { name: Schema.String }
) {}

export class ProjectDirectoryInvalid extends Schema.TaggedErrorClass<ProjectDirectoryInvalid>()(
  "ProjectDirectoryInvalid",
  { directory: Schema.String, reason: Schema.String }
) {}

export class ProjectDirectoryConflict extends Schema.TaggedErrorClass<ProjectDirectoryConflict>()(
  "ProjectDirectoryConflict",
  { directory: Schema.String }
) {}

// Raw input that failed Project's validation at the ingestion boundary (name or
// tag pattern, description length). Travels back to the client as a typed error.
export class ProjectInvalidInput extends Schema.TaggedErrorClass<ProjectInvalidInput>()(
  "ProjectInvalidInput",
  { field: Schema.String, reason: Schema.String }
) {}

// Payloads carry plain strings: the server validates them through Project at
// ingestion. The wire never references the branded vocabulary.
export class YodeaRpcs extends RpcGroup.make(
  Rpc.make("Health", { success: Schema.String }),
  Rpc.make("ProjectCreate", {
    payload: {
      name: Schema.String,
      ensure: Schema.Boolean,
      directory: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    success: ProjectCreateResult,
    error: Schema.Union([ProjectAlreadyExists, ProjectDirectoryInvalid, ProjectDirectoryConflict, ProjectInvalidInput])
  }),
  Rpc.make("ProjectRename", {
    payload: { id: Schema.String, name: Schema.String },
    success: Project,
    error: Schema.Union([ProjectNotFound, ProjectNameConflict, ProjectInvalidInput])
  }),
  Rpc.make("ProjectChangeDirectory", {
    payload: { id: Schema.String, directory: Schema.String },
    success: Project,
    error: Schema.Union([ProjectNotFound, ProjectDirectoryInvalid, ProjectDirectoryConflict])
  }),
  Rpc.make("ProjectArchive", { payload: { id: Schema.String }, success: Project, error: ProjectNotFound }),
  Rpc.make("ProjectRestore", { payload: { id: Schema.String }, success: Project, error: ProjectNotFound }),
  Rpc.make("ProjectSetMetadata", {
    payload: {
      id: Schema.String,
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      tags: Schema.optionalKey(Schema.Array(Schema.String))
    },
    success: Project,
    error: Schema.Union([ProjectNotFound, ProjectInvalidInput])
  }),
  Rpc.make("ProjectDelete", {
    payload: { id: Schema.String },
    success: ProjectDeleteResult,
    error: ProjectNotFound
  }),
  Rpc.make("ProjectList", {
    payload: { includeArchived: Schema.optionalKey(Schema.Boolean) },
    success: Schema.Struct({ projects: Schema.Array(Project), seq: Schema.Int })
  }),
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  Rpc.make("Events", {
    payload: { fromSeq: Schema.optionalKey(Schema.Int) },
    success: SequencedEvent,
    stream: true
  })
) {}
