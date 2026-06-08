import { test, expect } from "@playwright/test"
import { launchApp, createProject, openPalette } from "./helpers"

test("edits project metadata via the command palette", async () => {
  const { app, win } = await launchApp()
  await createProject(win, "e2e-meta")

  await openPalette(win)
  await win.getByPlaceholder("Type a project name or search…").fill("e2e-meta")
  await win.getByRole("option", { name: /Edit metadata “e2e-meta”/ }).click()

  const dialog = win.getByRole("dialog")
  await dialog.getByLabel("description").fill("an e2e project")
  await dialog.getByLabel("tags").fill("alpha, beta")
  await dialog.getByRole("button", { name: "Save" }).click()

  // EditMetadataDialog closes only when onSubmit resolves without throwing.
  await expect(win.getByRole("dialog")).toHaveCount(0)
  await expect(win.locator("[role=alert]")).toHaveCount(0)

  // The project still resolves in the palette afterwards (stream stayed healthy).
  await openPalette(win)
  await win.getByPlaceholder("Type a project name or search…").fill("e2e-meta")
  await expect(win.getByRole("option", { name: "e2e-meta", exact: true })).toBeVisible()
  await app.close()
})
