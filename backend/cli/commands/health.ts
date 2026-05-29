import { Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { withClient } from "@yodea/cli/rpc-client"

const json = Flag.boolean("json").pipe(Flag.withDefault(false))

export const healthCommand = Command.make("health", { json }, ({ json }) =>
  withClient({ port: 0 }, (client) =>
    Effect.flatMap(client.Health(), (status) =>
      Console.log(json ? JSON.stringify({ status }) : status)
    )
  )
)
