import { Effect } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/envelope"
import { ServerClient } from "@expand/client-ts"
import { defineCommand } from "@expand/cli/_command"

export const healthCommand = defineCommand(
  "health",
  {},
  {
    envelope: (status: string) => ({ apiVersion: ENVELOPE_VERSION, kind: "ServerHealth", data: { status } }),
    text: (status: string) => `server: ${status}`,
    quiet: (status: string) => status
  },
  (): Effect.Effect<string, unknown, ServerClient> => Effect.flatMap(ServerClient, (c) => c.health())
)
