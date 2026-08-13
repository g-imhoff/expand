import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import type { Project } from "@expand/contracts/project"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"
import { resolveProjectTarget } from "@expand/cli/commands/project/resolve-project-target"

export const renameCommand = (() => {
  const target = Argument.string("project")
  const name = Argument.string("name")

  return defineCommand(
    "rename",
    { project: target, name },
    {
      envelope: (p: Project) => makeEnvelope("Project", { created: false, data: p }),
      text: (p: Project) => `${p.id}  ${p.name}`,
      quiet: (p: Project) => p.id
    },
    ({ project, name }): Effect.Effect<Project, unknown, ProjectClient> =>
      Effect.gen(function* () {
        const c = yield* ProjectClient
        const id = yield* resolveProjectTarget(project)
        return yield* c.rename({ id, name })
      })
  )
})()
