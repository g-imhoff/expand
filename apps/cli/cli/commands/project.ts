import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"

const json = Flag.boolean("json").pipe(Flag.withDefault(false))
const name = Argument.string("name")

const create = Command.make("create", { name, json }, ({ name, json }) =>
  withClient(bunAdapter, (client) =>
    Effect.flatMap(client.ProjectCreate({ name }), (project) =>
      Console.log(json ? JSON.stringify(project) : `created ${project.id}  ${project.name}`)
    )
  )
)

const ls = Command.make("ls", { json }, ({ json }) =>
  withClient(bunAdapter, (client) =>
    Effect.flatMap(client.ProjectList(), (projects) =>
      json
        ? Console.log(JSON.stringify(projects))
        : Effect.forEach(projects, (p) => Console.log(`${p.id}  ${p.name}`), {
            discard: true
          })
    )
  )
)

export const projectCommand = Command.make("project", {}, () =>
  Console.log("usage: yodea project <create|ls>")
).pipe(Command.withSubcommands([create, ls]))
