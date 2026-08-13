import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { render } from "ink"
import { App } from "@expand/tui/components/app"
import { RuntimeContext, makeProductionRuntime, tuiProgram } from "@expand/tui/runtime/tui-runtime"

NodeRuntime.runMain(
  tuiProgram({
    makeRuntime: makeProductionRuntime,
    render: (runtime) => render(
      <RuntimeContext.Provider value={runtime}>
        <App />
      </RuntimeContext.Provider>
    )
  }).pipe(Effect.provide(NodeServices.layer))
)
