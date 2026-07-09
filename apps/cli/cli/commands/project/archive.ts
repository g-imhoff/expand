import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/envelope"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/_command"
import { resolveProjectTarget } from "@expand/cli/commands/project/_resolve"

const target = Argument.string("project")

export const archiveCommand = defineCommand(
  "archive",
  { project: target },
  {
    envelope: (p: Project) => ({ apiVersion: ENVELOPE_VERSION, kind: "Project", created: false, data: p }),
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
