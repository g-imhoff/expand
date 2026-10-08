import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { SidebarScenario } from "./scenarios/sidebar-two-worktrees-unread"
import "./preview.css"

const root = document.getElementById("root")
if (root === null) throw new Error("Design preview root is missing")

createRoot(root).render(
  <StrictMode>
    <SidebarScenario />
  </StrictMode>
)
