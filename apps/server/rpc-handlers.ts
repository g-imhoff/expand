import { YodeaRpcs } from "@yodea/contracts/rpc"
import { projectHandlers } from "@yodea/server/rpc/projects"
import { serverHandlers } from "@yodea/server/rpc/server"
import { streamHandlers } from "@yodea/server/rpc/stream"

export const YodeaHandlers = YodeaRpcs.toLayer({
  ...projectHandlers,
  ...serverHandlers,
  ...streamHandlers
})
