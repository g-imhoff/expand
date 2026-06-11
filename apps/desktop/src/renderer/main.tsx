import "./index.css"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { Cause, Effect, Exit } from "effect"
import { boot } from "@yodea/desktop/renderer/app/runtime"
import { AppHandleProvider } from "@yodea/desktop/renderer/app/AppHandleProvider"
import { router } from "@yodea/desktop/renderer/app/router"
import { BootError } from "@yodea/desktop/renderer/app/BootError"
import { supervised } from "@yodea/desktop/renderer/lib/supervised"

const root = createRoot(document.getElementById("root")!)
root.render(<div style={{ fontFamily: "system-ui", padding: 24 }}>Connecting…</div>)

const fiber = Effect.runFork(
  supervised(
    "renderer boot",
    boot((handle) => {
      root.render(
        <AppHandleProvider value={handle}>
          <RouterProvider router={router} />
        </AppHandleProvider>
      )
    })
  )
)
fiber.addObserver((exit) => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    root.render(<BootError message={Cause.pretty(exit.cause)} />)
  }
})
