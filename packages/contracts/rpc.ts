import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainEvent } from "@yodea/contracts/events/domain"
import { DESCRIPTION_MAX_LENGTH, Project, ProjectCreateResult, ProjectDeleteResult, Tag } from "@yodea/contracts/project"

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

export class YodeaRpcs extends RpcGroup.make(
  Rpc.make("Health", { success: Schema.String }),
  Rpc.make("ProjectCreate", {
    payload: {
      name: Schema.String,
      ensure: Schema.Boolean,
      directory: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    success: ProjectCreateResult,
    error: Schema.Union([ProjectAlreadyExists, ProjectDirectoryInvalid, ProjectDirectoryConflict])
  }),
  Rpc.make("ProjectRename", {
    payload: { id: Schema.String, name: Schema.String },
    success: Project,
    error: Schema.Union([ProjectNotFound, ProjectNameConflict])
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
      description: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))))),
      tags: Schema.optionalKey(Schema.Array(Tag))
    },
    success: Project,
    error: ProjectNotFound
  }),
  Rpc.make("ProjectDelete", {
    payload: { id: Schema.String },
    success: ProjectDeleteResult,
    error: ProjectNotFound
  }),
  Rpc.make("ProjectList", { payload: { includeArchived: Schema.optionalKey(Schema.Boolean) }, success: Schema.Array(Project) }),
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  Rpc.make("Events", { success: DomainEvent, stream: true })
) {}
