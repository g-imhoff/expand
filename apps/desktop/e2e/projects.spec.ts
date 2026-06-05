import { test, expect, _electron as electron } from "@playwright/test"
import { resolve } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

const repoRoot = resolve(__dirname, "../../..")

test("creates a project and shows it live", async () => {
  const app = await electron.launch({
    args: ["--no-sandbox", resolve(__dirname, "../out/main/index.mjs")],
    env: {
      ...process.env,
      YODEA_DB: resolve(mkdtempSync(resolve(tmpdir(), "yodea-e2e-")), "events.db"),
      YODEA_BACKEND_CMD: JSON.stringify(["bun", resolve(repoRoot, "apps/server/main.ts")])
    }
  })
  const win = await app.firstWindow()
  await expect(win.getByText("Projects (")).toBeVisible()
  await expect(win.locator("[role=alert]")).toHaveCount(0)

  await win.getByLabel("project name").fill("e2e-alpha")
  await win.getByRole("button", { name: "Create" }).click()
  await expect(win.getByTestId("project-list")).toContainText("e2e-alpha")
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
