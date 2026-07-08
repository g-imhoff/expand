import { render } from "ink"
import { App } from "@expand/tui/components/app"
import { RuntimeContext, makeProductionRuntime } from "@expand/tui/runtime"

const runtime = makeProductionRuntime()
const { waitUntilExit } = render(
  <RuntimeContext.Provider value={runtime}>
    <App />
  </RuntimeContext.Provider>
)
waitUntilExit().then(() => runtime.dispose())
