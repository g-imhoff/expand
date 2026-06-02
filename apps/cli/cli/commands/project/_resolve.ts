import { Effect, Schema } from "effect"
import { ProjectId } from "@yodea/contracts/project"
import { ProjectNotFound } from "@yodea/contracts/rpc"
import { YodeaClient } from "@yodea/client-core"

const isUuid = Schema.is(ProjectId)

export const resolveProjectTarget = (token: string) =>
  isUuid(token)
    ? Effect.succeed(token)
    : Effect.flatMap(YodeaClient, (c) => c.ProjectList({ includeArchived: true })).pipe(
        Effect.flatMap((ps) => {
          const matches = ps.filter((p) => p.name === token)
          if (matches.length > 1) {
            return Effect.die(
              new Error(`Ambiguous project name "${token}": ${matches.length} live projects share it`)
            )
          }
          const match = matches[0]
          return match === undefined
            ? Effect.fail(new ProjectNotFound({ id: token }))
            : Effect.succeed(match.id)
        })
      )
