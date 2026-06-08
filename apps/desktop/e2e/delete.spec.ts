import { test, expect } from "@playwright/test"
import { launchApp, createProject } from "./helpers"

test("deletes a project and removes it from the live list", async () => {
  const { app, win } = await launchApp()
  await createProject(win, "e2e-del")

  const list = win.getByTestId("project-list")
  await list.getByRole("listitem").filter({ hasText: "e2e-del" }).getByRole("button", { name: "Delete" }).click()

  // Confirm in the DeleteProjectDialog (its own "Delete" button, scoped to the dialog).
  await win.getByRole("dialog").getByRole("button", { name: "Delete" }).click()

  await expect(list).not.toContainText("e2e-del")
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
