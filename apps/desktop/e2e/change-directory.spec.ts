import { test, expect } from "@playwright/test"
import { tmpdir } from "node:os"
import { launchApp, createProject } from "./helpers"

test("sets a project directory without surfacing an error", async () => {
  const { app, win } = await launchApp()
  await createProject(win, "e2e-cd")

  const row = win.getByTestId("project-list").getByRole("listitem").filter({ hasText: "e2e-cd" })
  await row.getByRole("button", { name: "Change directory" }).click()

  await win.getByLabel("project directory").fill(tmpdir())
  await win.getByRole("dialog").getByRole("button", { name: "Save" }).click()

  // On success ChangeDirectoryDialog is dismissed (movingDir -> null) and no [role=alert] is shown.
  await expect(win.getByRole("dialog")).toHaveCount(0)
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
