import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/version"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"
import { resolveProjectTarget } from "@expand/cli/commands/project/resolve-project-target"

export const changeDirectoryCommand = (() => {
  const target = Argument.string("project")
  const directory = Argument.string("directory")

  return defineCommand(
    "change-directory",
    { project: target, directory },
    {
      envelope: (p: Project) => ({ apiVersion: ENVELOPE_VERSION, kind: "Project", created: false, data: p }),
      text: (p: Project) => `${p.id}  ${p.name}`,
      quiet: (p: Project) => p.id
    },
    ({ project, directory }): Effect.Effect<Project, unknown, ProjectClient> =>
      Effect.gen(function* () {
        const c = yield* ProjectClient
        const id = yield* resolveProjectTarget(project)
        return yield* c.changeDirectory({ id, directory })
      })
  )
})()
