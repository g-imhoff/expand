import "./index.css"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { Cause, Effect, Exit } from "effect"
import { boot } from "@expand/desktop/renderer/app/runtime"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { router } from "@expand/desktop/renderer/app/router"
import { BootError } from "@expand/desktop/renderer/app/BootError"
import { supervised } from "@expand/desktop/renderer/lib/supervised"

const root = createRoot(document.getElementById("root")!)
root.render(<div style={{ fontFamily: "system-ui", padding: 24 }}>Connecting…</div>)

const fiber = Effect.runFork(
  supervised(
    "renderer boot",
    boot((value) => {
      root.render(
        <ProjectContextProvider value={value}>
          <RouterProvider router={router} />
        </ProjectContextProvider>
      )
    })
  )
)
fiber.addObserver((exit) => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    root.render(<BootError message={Cause.pretty(exit.cause)} />)
  }
})
