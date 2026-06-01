import { Argument, Flag } from "effect/unstable/cli"
import { Effect } from "effect"
import { ProjectName } from "@yodea/contracts/project"
import { API_VERSION } from "@yodea/contracts/cli"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"

const name = Argument.string("name").pipe(Argument.withSchema(ProjectName))
const ensure = Flag.boolean("ensure").pipe(Flag.withDefault(false))

type CreateResult = { created: boolean; project: { id: string; name: string; createdAt: string } }

export const createCommand = defineCommand(
  "create",
  { name, ensure },
  {
    envelope: (r: CreateResult) => ({ apiVersion: API_VERSION, kind: "Project", created: r.created, data: r.project }),
    text: (r: CreateResult) => `created ${r.project.id}  ${r.project.name}`,
    quiet: (r: CreateResult) => r.project.id
  },
  ({ name, ensure }): Effect.Effect<CreateResult, unknown, YodeaClient> =>
    Effect.flatMap(YodeaClient, (c) => c.ProjectCreate({ name, ensure }))
)
