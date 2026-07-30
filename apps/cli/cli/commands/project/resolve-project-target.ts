import { Effect } from "effect"
import type { RpcClientError } from "effect/unstable/rpc"
import { ProjectNotFound } from "@expand/contracts/rpc"
import { ProjectClient } from "@expand/client-ts/project"

export const resolveProjectTarget = Effect.fn("Cli.resolveProjectTarget")((
  token: string
): Effect.Effect<string, RpcClientError.RpcClientError | ProjectNotFound, ProjectClient> =>
  UUID_RE.test(token)
    ? Effect.succeed(token)
    : Effect.flatMap(ProjectClient, (c) => c.list({ includeArchived: true })).pipe(
      Effect.flatMap(({ projects: ps }) => {
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
)

// A target token is an id when it looks like a UUID; otherwise it's a name to
// resolve. This is a transport-level shape check, not Project's private rule.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
