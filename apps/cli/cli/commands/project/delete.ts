import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import type { ProjectDeleteResult } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"
import { resolveProjectTarget } from "@expand/cli/commands/project/resolve-project-target"

export const deleteCommand = (() => {
  const target = Argument.string("project")

  return defineCommand(
    "delete",
    { project: target },
    {
      envelope: (r: ProjectDeleteResult) => makeEnvelope("ProjectDelete", { data: r }),
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
})()
