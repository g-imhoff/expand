import { Effect, Schema } from "effect"
import type { DomainEvent } from "@yodea/contracts/events/domain"

export class Project extends Schema.Class<Project>("Project")({
  id: Schema.String.pipe(Schema.check(Schema.isUUID(4)), Schema.brand("ProjectId")),
  name: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)), Schema.brand("ProjectName")),
  directory: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  description: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  tags: Schema.Array(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)), Schema.brand("Tag"))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  archived: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: Schema.String,
  updatedAt: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("")))
}) {
  static fromCreated(e: ProjectCreatedEvent): Project {
    return new Project({
      id: e.projectId as ProjectId,
      name: e.name as ProjectName,
      directory: e.directory ?? null,
      description: null,
      tags: [],
      archived: false,
      createdAt: e.occurredAt,
      updatedAt: e.occurredAt
    }, { disableChecks: true })
  }

  static applyEvent(p: Project, e: DomainEvent): Project {
    switch (e._tag) {
      case "ProjectRenamed":
        return new Project({ ...p, name: e.name as ProjectName, updatedAt: e.occurredAt }, { disableChecks: true })
      case "ProjectDirectoryChanged":
        return new Project({ ...p, directory: e.directory, updatedAt: e.occurredAt }, { disableChecks: true })
      case "ProjectArchived":
        return new Project({ ...p, archived: true, updatedAt: e.occurredAt }, { disableChecks: true })
      case "ProjectRestored":
        return new Project({ ...p, archived: false, updatedAt: e.occurredAt }, { disableChecks: true })
      case "ProjectMetadataChanged":
        return new Project({
          ...p,
          ...(e.description !== undefined ? { description: e.description } : {}),
          ...(e.tags !== undefined ? { tags: [...new Set(e.tags)].map((t) => t as Tag) } : {}),
          updatedAt: e.occurredAt
        }, { disableChecks: true })
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
) { }

export class ProjectDeleteResult extends Schema.Opaque<ProjectDeleteResult>()(
  Schema.Struct({ id: Schema.String, deleted: Schema.Boolean })
) { }

type ProjectCreatedEvent = Extract<DomainEvent, { _tag: "ProjectCreated" }>
type ProjectId = Project["id"]
type ProjectName = Project["name"]
type Tag = Project["tags"][number]
