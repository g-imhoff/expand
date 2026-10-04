import { ExpandRpcs } from "@expand/contracts/rpc"
import { automationHandlers } from "@expand/server/rpc/automation"
import { projectHandlers } from "@expand/server/rpc/projects"
import { serverHandlers } from "@expand/server/rpc/server"
import { streamHandlers } from "@expand/server/rpc/stream"
import { backendConnectionHandlers } from "@expand/server/rpc/backend-connection"

export const ExpandHandlers = ExpandRpcs.toLayer({
  ...projectHandlers,
  ...serverHandlers,
  ...streamHandlers,
  ...automationHandlers,
  ...backendConnectionHandlers
})
