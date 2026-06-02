import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Schema } from "effect"
import { DomainEvent } from "@yodea/contracts/events"
import { Project, ProjectCreateResult } from "@yodea/contracts/project"

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

export class YodeaRpcs extends RpcGroup.make(
  // Liveness query.
  Rpc.make("Health", { success: Schema.String }),
  // Command: create a project. `ensure` makes it an idempotent no-op when the
  // name already exists (returns the existing project, created:false). A strict
  // create on a duplicate name fails with ProjectAlreadyExists.
  Rpc.make("ProjectCreate", {
    payload: { name: Schema.String, ensure: Schema.Boolean },
    success: ProjectCreateResult,
    error: ProjectAlreadyExists
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
