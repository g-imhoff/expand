import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/envelope"
import type { ProjectDeleteResult } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-core"
import { defineCommand } from "@expand/cli/_command"
import { resolveProjectTarget } from "@expand/cli/commands/project/_resolve"

const target = Argument.string("project")

export const deleteCommand = defineCommand(
  "delete",
  { project: target },
  {
    envelope: (r: ProjectDeleteResult) => ({ apiVersion: ENVELOPE_VERSION, kind: "ProjectDelete", data: r }),
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
