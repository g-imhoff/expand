import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import type { Project } from "@yodea/contracts/project"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"
import { resolveProjectTarget } from "@yodea/cli/commands/project/_resolve"

const target = Argument.string("project")
const directory = Argument.string("directory")

export const changeDirectoryCommand = defineCommand(
  "change-directory",
  { project: target, directory },
  {
    envelope: (p: Project) => ({ apiVersion: API_VERSION, kind: "Project", created: false, data: p }),
    text: (p: Project) => `${p.id}  ${p.name}`,
    quiet: (p: Project) => p.id
  },
  ({ project, directory }): Effect.Effect<Project, unknown, YodeaClient> =>
    Effect.gen(function* () {
      const c = yield* YodeaClient
      const id = yield* resolveProjectTarget(project)
      return yield* c.ProjectChangeDirectory({ id, directory })
    })
)
