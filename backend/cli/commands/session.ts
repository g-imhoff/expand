import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { withClient } from "@yodea/cli/rpc-client"

const json = Flag.boolean("json").pipe(Flag.withDefault(false))
const title = Argument.string("title")

const create = Command.make("create", { title, json }, ({ title, json }) =>
  withClient((client) =>
    Effect.flatMap(client.SessionCreate({ title }), (session) =>
      Console.log(json ? JSON.stringify(session) : `created ${session.id}  ${session.title}`)
    )
  )
)

const ls = Command.make("ls", { json }, ({ json }) =>
  withClient((client) =>
    Effect.flatMap(client.SessionList(), (sessions) =>
      json
        ? Console.log(JSON.stringify(sessions))
        : Effect.forEach(sessions, (s) => Console.log(`${s.id}  ${s.title}`), {
            discard: true
          })
    )
  )
)

export const sessionCommand = Command.make("session", {}, () =>
  Console.log("usage: yodea session <create|ls>")
).pipe(Command.withSubcommands([create, ls]))
