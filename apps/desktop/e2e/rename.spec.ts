import { test, expect } from "@playwright/test"
import { launchApp, createProject } from "./helpers"

test("renames a project and the list reflects the new name", async () => {
  const { app, win } = await launchApp()
  await createProject(win, "e2e-rename-src")

  const list = win.getByTestId("project-list")
  await list.getByRole("listitem").filter({ hasText: "e2e-rename-src" }).getByRole("button", { name: "Rename" }).click()

  await win.getByLabel("new project name").fill("e2e-rename-dst")
  await win.getByRole("dialog").getByRole("button", { name: "Rename" }).click()

  await expect(list).toContainText("e2e-rename-dst")
  await expect(list).not.toContainText("e2e-rename-src")
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
