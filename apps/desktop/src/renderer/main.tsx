import "./index.css"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { boot } from "@yodea/desktop/renderer/app/runtime"
import { AppHandleProvider } from "@yodea/desktop/renderer/app/AppHandleProvider"
import { router } from "@yodea/desktop/renderer/app/router"
import { supervised } from "@yodea/desktop/renderer/lib/supervised"

const root = createRoot(document.getElementById("root")!)
root.render(<div style={{ fontFamily: "system-ui", padding: 24 }}>Connecting…</div>)

Effect.runFork(
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
