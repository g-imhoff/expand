import { Argument } from "effect/unstable/cli"
import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import type { ProjectDeleteResult } from "@yodea/contracts/project"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"
import { resolveProjectTarget } from "@yodea/cli/commands/project/_resolve"

// target accepts a project NAME or UUID (no withSchema); resolveProjectTarget
// turns it into an id (passing a UUID straight through, resolving a name via list).
// Delete is IMMEDIATE in the machine contract — no interactive prompt (confirmation
// is a TUI/desktop concern). Uses the distinct ProjectDeleteEnvelope (kind
// "ProjectDelete"), not ProjectEnvelope, since it returns a ProjectDeleteResult.
const target = Argument.string("project")

export const deleteCommand = defineCommand(
  "delete",
  { project: target },
  {
    envelope: (r: ProjectDeleteResult) => ({ apiVersion: API_VERSION, kind: "ProjectDelete", data: r }),
    text: (r: ProjectDeleteResult) => `deleted ${r.id}`,
    quiet: (r: ProjectDeleteResult) => r.id
  },
  ({ project }): Effect.Effect<ProjectDeleteResult, unknown, YodeaClient> =>
    Effect.gen(function* () {
      const c = yield* YodeaClient
      const id = yield* resolveProjectTarget(project)
      return yield* c.ProjectDelete({ id })
    })
)
