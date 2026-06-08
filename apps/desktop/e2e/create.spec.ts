import { test, expect } from "@playwright/test"
import { launchApp, createProject } from "./helpers"

test("creates a project and shows it live", async () => {
  const { app, win } = await launchApp()
  await expect(win.getByText("Projects (")).toBeVisible()
  await expect(win.locator("[role=alert]")).toHaveCount(0)

  await createProject(win, "e2e-alpha")
  await expect(win.getByTestId("project-list")).toContainText("e2e-alpha")
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
