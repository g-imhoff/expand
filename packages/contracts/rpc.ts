import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainEvent } from "@yodea/contracts/events"
import { DESCRIPTION_MAX_LENGTH, Project, ProjectCreateResult, ProjectDeleteResult, Tag } from "@yodea/contracts/project"

// Typed RPC error: a name conflict on create. Schema-backed so it rides the wire.
export class ProjectAlreadyExists extends Schema.TaggedErrorClass<ProjectAlreadyExists>()(
  "ProjectAlreadyExists",
  { name: Schema.String }
) {}

// Typed RPC error: a project target (id or name) was not found. Shared by the
// mutating operations and the CLI's resolveProjectTarget helper.
export class ProjectNotFound extends Schema.TaggedErrorClass<ProjectNotFound>()(
  "ProjectNotFound",
  { id: Schema.String }
) {}

// Typed RPC error: a rename target the requested name is already taken by another
// live project (archived included — an archived name stays reserved).
export class ProjectNameConflict extends Schema.TaggedErrorClass<ProjectNameConflict>()(
  "ProjectNameConflict",
  { name: Schema.String }
) {}

// Typed RPC error: a change-directory target path failed server-side validation.
// `reason` is "not-absolute" (relative path) or "not-found" (not on disk).
export class ProjectDirectoryInvalid extends Schema.TaggedErrorClass<ProjectDirectoryInvalid>()(
  "ProjectDirectoryInvalid",
  { directory: Schema.String, reason: Schema.String }
) {}

// Typed RPC error: another live project already uses the requested directory
// (archived included — an archived directory stays reserved).
export class ProjectDirectoryConflict extends Schema.TaggedErrorClass<ProjectDirectoryConflict>()(
  "ProjectDirectoryConflict",
  { directory: Schema.String }
) {}

export class YodeaRpcs extends RpcGroup.make(
  // Liveness query.
  Rpc.make("Health", { success: Schema.String }),
  // Command: create a project. `ensure` makes it an idempotent no-op when the
  // name already exists (returns the existing project, created:false). A strict
  // create on a duplicate name fails with ProjectAlreadyExists.
  Rpc.make("ProjectCreate", {
    payload: {
      name: Schema.String,
      ensure: Schema.Boolean,
      // (D2) directory is optional at create. When a non-null path is given the
      // backend validates it server-side (absolute + on-disk + unique among live).
      directory: Schema.optionalKey(Schema.NullOr(Schema.String))
    },
    success: ProjectCreateResult,
    error: Schema.Union([ProjectAlreadyExists, ProjectDirectoryInvalid, ProjectDirectoryConflict])
  }),
  // Command: rename a project (by id). Fails ProjectNotFound if the target is
  // gone, ProjectNameConflict if another live project already owns the name.
  Rpc.make("ProjectRename", {
    payload: { id: Schema.String, name: Schema.String },
    success: Project,
    error: Schema.Union([ProjectNotFound, ProjectNameConflict])
  }),
  // Command: change a project's working directory (by id). Validated server-side:
  // ProjectNotFound (missing target), ProjectDirectoryInvalid (relative or not on
  // disk), ProjectDirectoryConflict (used by another live project).
  Rpc.make("ProjectChangeDirectory", {
    payload: { id: Schema.String, directory: Schema.String },
    success: Project,
    error: Schema.Union([ProjectNotFound, ProjectDirectoryInvalid, ProjectDirectoryConflict])
  }),
  // Command: archive a project (by id). Hides it from the default list but keeps
  // it live (name/directory stay reserved). Fails ProjectNotFound if absent.
  Rpc.make("ProjectArchive", { payload: { id: Schema.String }, success: Project, error: ProjectNotFound }),
  // Command: restore (un-archive) a project (by id). Fails ProjectNotFound if absent.
  Rpc.make("ProjectRestore", { payload: { id: Schema.String }, success: Project, error: ProjectNotFound }),
  // Command: set a project's metadata (by id), replace-style. Only the provided
  // fields change: present `description` (incl. null) and present `tags` replace;
  // absent leaves that field unchanged. Fails ProjectNotFound if absent.
  Rpc.make("ProjectSetMetadata", {
    payload: {
      id: Schema.String,
      // description capped at DESCRIPTION_MAX_LENGTH (2048) at the wire boundary.
      description: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))))),
      tags: Schema.optionalKey(Schema.Array(Tag))
    },
    success: Project,
    error: ProjectNotFound
  }),
  // Command: delete a project (by id) — soft tombstone. Succeeds with
  // { id, deleted: true }; the project is removed from every read-model and never
  // reappears. Fails ProjectNotFound if the target is absent.
  Rpc.make("ProjectDelete", {
    payload: { id: Schema.String },
    success: ProjectDeleteResult,
    error: ProjectNotFound
  }),
  // Query: list projects (projection). `includeArchived` (default false) controls
  // whether archived projects are returned; deleted are always excluded.
  Rpc.make("ProjectList", { payload: { includeArchived: Schema.optionalKey(Schema.Boolean) }, success: Schema.Array(Project) }),
  // Presence channel (I-4): a frontend subscribes on connect and holds it for
  // the lifetime of its work. The server emits one `true` immediately so the
  // client can confirm it was registered, then keeps it open until the socket drops.
  Rpc.make("Connect", { success: Schema.Boolean, stream: true }),
  // Live stream: every DomainEvent the backend commits (for read-model frontends).
  Rpc.make("Events", { success: DomainEvent, stream: true })
) {}
