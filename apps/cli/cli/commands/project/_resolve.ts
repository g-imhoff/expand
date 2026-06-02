import { Effect, Schema } from "effect"
import { ProjectId } from "@yodea/contracts/project"
import { ProjectNotFound } from "@yodea/contracts/rpc"
import { YodeaClient } from "@yodea/client-core"

const isUuid = Schema.is(ProjectId)

// Resolve a CLI target (project name OR UUID) to a project id. A UUID passes
// through without a round-trip; a name is matched against the full project set
// (archived included) so an archived project is still addressable.
export const resolveProjectTarget = (token: string) =>
  isUuid(token)
    ? Effect.succeed(token)
    : Effect.flatMap(YodeaClient, (c) => c.ProjectList({ includeArchived: true })).pipe(
        Effect.flatMap((ps) => {
          const matches = ps.filter((p) => p.name === token)
          return matches.length === 1 && matches[0] !== undefined
            ? Effect.succeed(matches[0].id)
            : Effect.fail(new ProjectNotFound({ id: token }))
        })
      )
