import "./index.css"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { Providers } from "@yodea/desktop/renderer/app/providers"
import { router } from "@yodea/desktop/renderer/app/router"

createRoot(document.getElementById("root")!).render(
  <Providers>
    <RouterProvider router={router} />
  </Providers>
)
