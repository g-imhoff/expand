import { Effect, Schema } from "effect"
import { DESCRIPTION_MAX_LENGTH, ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import { DomainEventMeta, withMeta } from "@yodea/contracts/events/meta"

const ProjectEventMeta = {
  projectId: ProjectId
}

export const ProjectEvent = Schema.TaggedUnion(
  withMeta({ ...DomainEventMeta, ...ProjectEventMeta }, {
    ProjectCreated: {
      name: ProjectName,
      directory: Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
    },
    ProjectRenamed: {
      name: ProjectName
    },
    ProjectDirectoryChanged: {
      directory: Schema.String
    },
    ProjectArchived: {},
    ProjectRestored: {},
    ProjectMetadataChanged: {
      description: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(DESCRIPTION_MAX_LENGTH))))),
      tags: Schema.optionalKey(Schema.Array(Tag))
    },
    ProjectDeleted: {}
  })
)
export type ProjectEvent = typeof ProjectEvent.Type

export const {
  ProjectCreated,
  ProjectRenamed,
  ProjectDirectoryChanged,
  ProjectArchived,
  ProjectRestored,
  ProjectMetadataChanged,
  ProjectDeleted
} = ProjectEvent.cases
