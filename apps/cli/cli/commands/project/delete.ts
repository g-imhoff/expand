import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import type { ProjectDeleteResult } from "@yodea/contracts/project"
import { ProjectClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"
import { resolveProjectTarget } from "@yodea/cli/commands/project/_resolve"

const target = Argument.string("project")

export const deleteCommand = defineCommand(
  "delete",
  { project: target },
  {
    envelope: (r: ProjectDeleteResult) => ({ apiVersion: API_VERSION, kind: "ProjectDelete", data: r }),
    text: (r: ProjectDeleteResult) => `deleted ${r.id}`,
    quiet: (r: ProjectDeleteResult) => r.id
  },
  ({ project }): Effect.Effect<ProjectDeleteResult, unknown, ProjectClient> =>
    Effect.gen(function* () {
      const c = yield* ProjectClient
      const id = yield* resolveProjectTarget(project)
      return yield* c.delete({ id })
    })
)
