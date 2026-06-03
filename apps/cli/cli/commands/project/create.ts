import { Argument, Flag } from "effect/unstable/cli"
import { Effect, Option } from "effect"
import { ProjectName } from "@yodea/contracts/project"
import { API_VERSION } from "@yodea/contracts/cli"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"

const name = Argument.string("name").pipe(Argument.withSchema(ProjectName))
const ensure = Flag.boolean("ensure").pipe(Flag.withDefault(false))
// (D2) --directory is optional: present sets the project's directory at create
// (validated server-side: absolute + on-disk + unique); absent leaves it null.
const directory = Flag.string("directory").pipe(Flag.optional)

type CreateResult = { created: boolean; project: { id: string; name: string; directory?: string | null; createdAt: string } }

export const createCommand = defineCommand(
  "create",
  { name, ensure, directory },
  {
    envelope: (r: CreateResult) => ({ apiVersion: API_VERSION, kind: "Project", created: r.created, data: r.project }),
    text: (r: CreateResult) => `created ${r.project.id}  ${r.project.name}`,
    quiet: (r: CreateResult) => r.project.id
  },
  ({ name, ensure, directory }): Effect.Effect<CreateResult, unknown, YodeaClient> =>
    Effect.flatMap(YodeaClient, (c) =>
      c.ProjectCreate({ name, ensure, ...(Option.isSome(directory) ? { directory: directory.value } : {}) }))
)
