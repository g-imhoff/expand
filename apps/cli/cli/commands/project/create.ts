import { Argument, Flag } from "effect/unstable/cli"
import { Effect, Option } from "effect"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"

export const createCommand = (() => {
  const name = Argument.string("name")
  const ensure = Flag.boolean("ensure").pipe(Flag.withDefault(false))
  const directory = Flag.string("directory").pipe(Flag.optional)

  return defineCommand(
    "create",
    { name, ensure, directory },
    {
      envelope: (r: CreateResult) => makeEnvelope("Project", { created: r.created, data: r.project }),
      text: (r: CreateResult) => `created ${r.project.id}  ${r.project.name}`,
      quiet: (r: CreateResult) => r.project.id
    },
    ({ name, ensure, directory }): Effect.Effect<CreateResult, unknown, ProjectClient> =>
      Effect.flatMap(ProjectClient, (c) =>
        c.create({ name, ensure, ...(Option.isSome(directory) ? { directory: directory.value } : {}) }))
  )
})()

type CreateResult = { created: boolean; project: { id: string; name: string; directory?: string | null; createdAt: string } }
