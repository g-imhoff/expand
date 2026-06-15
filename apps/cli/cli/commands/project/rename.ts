import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import type { Project } from "@yodea/contracts/project"
import { API_VERSION } from "@yodea/contracts/cli"
import { ProjectClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"
import { resolveProjectTarget } from "@yodea/cli/commands/project/_resolve"

const target = Argument.string("project")
const name = Argument.string("name")

export const renameCommand = defineCommand(
  "rename",
  { project: target, name },
  {
    envelope: (p: Project) => ({ apiVersion: API_VERSION, kind: "Project", created: false, data: p }),
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
