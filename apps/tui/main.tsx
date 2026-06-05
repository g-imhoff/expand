import { render } from "ink"
import { App } from "@yodea/tui/components/app"
import { RuntimeContext, makeProductionRuntime } from "@yodea/tui/runtime"

const runtime = makeProductionRuntime()
const { waitUntilExit } = render(
  <RuntimeContext.Provider value={runtime}>
    <App />
  </RuntimeContext.Provider>
)
waitUntilExit().then(() => runtime.dispose())
