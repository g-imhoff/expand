import { ExpandRpcs } from "@expand/contracts/rpc"
import { projectHandlers } from "@expand/server/rpc/projects"
import { serverHandlers } from "@expand/server/rpc/server"
import { streamHandlers } from "@expand/server/rpc/stream"

export const ExpandHandlers = ExpandRpcs.toLayer({
  ...projectHandlers,
  ...serverHandlers,
  ...streamHandlers
})
