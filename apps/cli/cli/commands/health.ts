import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import { ServerClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"

export const healthCommand = defineCommand(
  "health",
  {},
  {
    envelope: (status: string) => ({ apiVersion: API_VERSION, kind: "ServerHealth", data: { status } }),
    text: (status: string) => `server: ${status}`,
    quiet: (status: string) => status
  },
  (): Effect.Effect<string, unknown, ServerClient> => Effect.flatMap(ServerClient, (c) => c.health())
)
