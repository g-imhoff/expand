import { test, expect, _electron as electron } from "@playwright/test"
import { resolve } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

// apps/desktop/e2e -> repo root (three levels up).
const repoRoot = resolve(__dirname, "../../..")

// Drives the BUILT app via Playwright's own isolated Electron (NOT the :9222 CDP
// port, which is reserved for the AI browser agent). Two env overrides are
// required because the built main runs with a cwd that is not apps/desktop:
//   - YODEA_HOME: an isolated temp dir so this test never touches real state or a
//     backend spawned by another agent.
//   - YODEA_BACKEND_CMD: the absolute backend command (the runtime's relative
//     default assumes cwd == apps/desktop, which is not the case here).
// --no-sandbox lets Electron launch in a headless/CI environment.
test("creates a project and shows it live", async () => {
  const app = await electron.launch({
    args: ["--no-sandbox", resolve(__dirname, "../out/main/index.mjs")],
    env: {
      ...process.env,
      YODEA_HOME: mkdtempSync(resolve(tmpdir(), "yodea-e2e-")),
      YODEA_BACKEND_CMD: JSON.stringify(["bun", resolve(repoRoot, "apps/cli/cli/main.ts"), "server"])
    }
  })
  const win = await app.firstWindow()
  await win.getByLabel("project name").fill("e2e-alpha")
  await win.getByRole("button", { name: "Create" }).click()
  await expect(win.getByTestId("project-list")).toContainText("e2e-alpha")
  await app.close()
})
