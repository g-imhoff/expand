import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/envelope"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-core"
import { defineCommand } from "@expand/cli/_command"
import { resolveProjectTarget } from "@expand/cli/commands/project/_resolve"

const target = Argument.string("project")
const directory = Argument.string("directory")

export const changeDirectoryCommand = defineCommand(
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
