import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"

export const healthCommand = defineCommand(
  "health",
  {},
  {
    kind: "Health",
    envelope: (status: string) => ({ apiVersion: API_VERSION, kind: "Health", data: { status } }),
    text: (status: string) => status,
    quiet: (status: string) => status
  },
  (): Effect.Effect<string, unknown, YodeaClient> => Effect.flatMap(YodeaClient, (c) => c.Health())
)
