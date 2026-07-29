import "./index.css"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { Cause, Crypto, Effect } from "effect"
import { BootError } from "@expand/desktop/renderer/app/BootError"
import { ownRendererRoot } from "@expand/desktop/renderer/app/root"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { boot } from "@expand/desktop/renderer/app/runtime"
import { router } from "@expand/desktop/renderer/app/router"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { supervised } from "@expand/desktop/renderer/lib/supervised"
import { browserCrypto } from "@expand/electron-ipc/renderer"

interface RendererHotContext {
  readonly dispose: (callback: () => void) => void
}

const root = createRoot(document.getElementById("root")!)
const getBridge = () => window.expand
const retry = () => window.location.reload()
const onDispose = (dispose: () => void): (() => void) => {
  const release = () => window.removeEventListener("unload", dispose)
  try {
    window.addEventListener("unload", dispose)
    const meta: ImportMeta & { readonly hot?: RendererHotContext } = import.meta
    meta.hot?.dispose(dispose)
    return release
  } catch (error) {
    try {
      release()
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "renderer root registration failed")
    }
    throw error
  }
}

ownRendererRoot({
  root,
  initial: <div style={{ fontFamily: "system-ui", padding: 24 }}>Connecting…</div>,
  start: (onExit) =>
    startRendererRoot(
      supervised(
        "renderer boot",
        boot(
          { bridge: getBridge, win: window },
          (value, runner) => {
            root.render(
              <RendererRunnerProvider value={runner}>
                <ProjectContextProvider value={value}>
                  <RouterProvider router={router} />
                </ProjectContextProvider>
              </RendererRunnerProvider>
            )
          }
        )
      ).pipe(Effect.provideService(Crypto.Crypto, browserCrypto)),
      onExit
    ),
  onDispose,
  renderFailure: (cause) => <BootError message={Cause.pretty(cause)} onRetry={retry} />
})
