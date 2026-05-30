// Renderer entry referenced by index.html (`<script src="./main.tsx">`). The React
// UI lands in Task 5.6; this stub mounts an empty root so the renderer input
// resolves and the HTML reference is not dangling.
import { createRoot } from "react-dom/client"

const root = document.getElementById("root")
if (root) createRoot(root).render(null)
