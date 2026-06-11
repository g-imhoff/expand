import { Effect, Schema } from "effect"
import type { Brand } from "effect"
import type { DomainEvent } from "@yodea/contracts/events/domain"

type ProjectCreatedEvent = Extract<DomainEvent, { _tag: "ProjectCreated" }>

export const ProjectName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  Schema.brand("ProjectName")
)
export type ProjectName = typeof ProjectName.Type

export const ProjectId = Schema.String.pipe(
  Schema.check(Schema.isUUID(4)),
  Schema.brand("ProjectId")
)
export type ProjectId = typeof ProjectId.Type

export const Tag = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  Schema.brand("Tag")
)
export type Tag = typeof Tag.Type

export const DESCRIPTION_MAX_LENGTH = 2048

export class Project extends Schema.Opaque<Project, Brand.Brand<"Project">>()(
  Schema.Struct({
    id: ProjectId,
    name: ProjectName,
    directory: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    description: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    tags: Schema.Array(Tag).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    archived: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    createdAt: Schema.String,
    updatedAt: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
  })
) {
  static fromCreated(e: ProjectCreatedEvent): Project {
    return Project.make({
      id: e.projectId,
      name: e.name,
      directory: e.directory ?? null,
      description: null,
      tags: [],
      archived: false,
      createdAt: e.occurredAt,
      updatedAt: e.occurredAt
    })
  }

  // Assumes e.projectId === p.id; matching is the caller's (or foldList's) job.
  static applyEvent(p: Project, e: DomainEvent): Project {
    switch (e._tag) {
      case "ProjectRenamed":
        return Project.make({ ...p, name: e.name, updatedAt: e.occurredAt })
      case "ProjectDirectoryChanged":
        return Project.make({ ...p, directory: e.directory, updatedAt: e.occurredAt })
      case "ProjectArchived":
        return Project.make({ ...p, archived: true, updatedAt: e.occurredAt })
      case "ProjectRestored":
        return Project.make({ ...p, archived: false, updatedAt: e.occurredAt })
      case "ProjectMetadataChanged":
        return Project.make({
          ...p,
          ...(e.description !== undefined ? { description: e.description } : {}),
          ...(e.tags !== undefined ? { tags: [...new Set(e.tags)] } : {}),
          updatedAt: e.occurredAt
        })
      default:
        return p
    }
  }

  static foldList(list: ReadonlyArray<Project>, e: DomainEvent): ReadonlyArray<Project> {
    switch (e._tag) {
      case "ProjectCreated":
        return list.some((p) => p.id === e.projectId) ? list : [...list, Project.fromCreated(e)]
      case "ProjectDeleted":
        return list.filter((p) => p.id !== e.projectId)
      default:
        return list.map((p) => (p.id === e.projectId ? Project.applyEvent(p, e) : p))
    }
  }
}

export class ProjectCreateResult extends Schema.Opaque<ProjectCreateResult>()(
  Schema.Struct({ created: Schema.Boolean, project: Project })
) {}

export class ProjectDeleteResult extends Schema.Opaque<ProjectDeleteResult>()(
  Schema.Struct({ id: Schema.String, deleted: Schema.Boolean })
) {}
