import { Effect, Schema } from "effect"
import { DomainEventMeta, withMeta } from "@yodea/contracts/events/meta"

const ProjectEventMeta = {
  projectId: Schema.String
}

export const ProjectEvent = Schema.TaggedUnion(
  withMeta({ ...DomainEventMeta, ...ProjectEventMeta }, {
    ProjectCreated: {
      name: Schema.String,
      directory: Schema.optionalKey(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null)))
    },
    ProjectRenamed: {
      name: Schema.String
    },
    ProjectDirectoryChanged: {
      directory: Schema.String
    },
    ProjectArchived: {},
    ProjectRestored: {},
    ProjectMetadataChanged: {
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      tags: Schema.optionalKey(Schema.Array(Schema.String))
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
