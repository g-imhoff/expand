import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"
import { resolveProjectTarget } from "@expand/cli/commands/project/resolve-project-target"

export const archiveCommand = (() => {
  const target = Argument.string("project")

  return defineCommand(
    "archive",
    { project: target },
    {
      envelope: (p: Project) => makeEnvelope("Project", { created: false, data: p }),
      text: (p: Project) => `${p.id}  ${p.name}`,
      quiet: (p: Project) => p.id
    },
    ({ project }): Effect.Effect<Project, unknown, ProjectClient> =>
      Effect.gen(function*() {
        const c = yield* ProjectClient
        const id = yield* resolveProjectTarget(project)
        return yield* c.archive({ id })
      })
  )
})()
