import { Command, Flag } from "effect/unstable/cli"
import { Console, Effect } from "effect"
import { withClient } from "@yodea/client-core"
import { bunAdapter } from "@yodea/client-core/adapters/bun"

const json = Flag.boolean("json").pipe(Flag.withDefault(false))

export const healthCommand = Command.make("health", { json }, ({ json }) =>
  withClient(bunAdapter, (client) =>
    Effect.flatMap(client.Health(), (status) =>
      Console.log(json ? JSON.stringify({ status }) : status)
    )
  )
)
