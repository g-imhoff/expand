import { render } from "ink"
import { App } from "@yodea/tui/components/app"
import { RuntimeContext, makeProductionRuntime } from "@yodea/tui/runtime"

const runtime = makeProductionRuntime()
const { waitUntilExit } = render(
  <RuntimeContext.Provider value={runtime}>
    <App />
  </RuntimeContext.Provider>
)
// Dispose the runtime (closes presence -> backend may self-shut-down) on exit.
waitUntilExit().then(() => runtime.dispose())
