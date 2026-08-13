import { Effect } from "effect"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import { ServerClient } from "@expand/client-ts/server"
import { defineCommand } from "@expand/cli/commands/define-command"

export const healthCommand = defineCommand(
  "health",
  {},
  {
    envelope: (status: string) => makeEnvelope("ServerHealth", { data: { status } }),
    text: (status: string) => `server: ${status}`,
    quiet: (status: string) => status
  },
  (): Effect.Effect<string, unknown, ServerClient> => Effect.flatMap(ServerClient, (c) => c.health())
)
