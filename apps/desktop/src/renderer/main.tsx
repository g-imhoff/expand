import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { Providers } from "@yodea/desktop/renderer/app/providers"
import { router } from "@yodea/desktop/renderer/app/router"

// Deliberately NOT wrapped in <StrictMode>: it double-invokes effects in dev, which
// would run the Providers bootstrap (MessagePort handshake + Effect runtime) twice
// and dispose the runtime between the two mounts — leaving `dev:desktop` stuck on
// "Connecting…". The renderer is a thin Effect shell, so StrictMode's render-purity
// checks add little; correct resource teardown (dispose on unmount) is kept instead.
createRoot(document.getElementById("root")!).render(
  <Providers>
    <RouterProvider router={router} />
  </Providers>
)
