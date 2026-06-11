import { test, expect } from "@playwright/test"
import { launchApp, createProject, openPalette } from "./helpers"

test("edits project metadata via the command palette", async () => {
  const { app, win } = await launchApp()
  await createProject(win, "e2e-meta")

  await openPalette(win)
  // Narrow with the edit item's own cmdk value ("edit e2e-meta") so it becomes the
  // sole/active option, then scroll it into the scrollable CommandList viewport before
  // clicking — without this the edit row sits below the fold and the click never lands.
  await win.getByPlaceholder("Type a project name or search…").fill("edit e2e-meta")
  const editOption = win.getByRole("option", { name: /Edit metadata “e2e-meta”/ })
  await editOption.scrollIntoViewIfNeeded()
  await editOption.click()

  const dialog = win.getByRole("dialog")
  await dialog.getByLabel("description").fill("an e2e project")
  await dialog.getByLabel("tags").fill("alpha, beta")
  await dialog.getByRole("button", { name: "Save" }).click()

  // EditMetadataDialog closes only when onSubmit resolves without throwing.
  await expect(win.getByRole("dialog")).toHaveCount(0)
  await expect(win.locator("[role=alert]")).toHaveCount(0)

  // Reopen the dialog via the palette: the persisted values must round-trip.
  await openPalette(win)
  await win.getByPlaceholder("Type a project name or search…").fill("edit e2e-meta")
  const reopened = win.getByRole("option", { name: /Edit metadata “e2e-meta”/ })
  await reopened.scrollIntoViewIfNeeded()
  await reopened.click()
  const reopenedDialog = win.getByRole("dialog")
  await expect(reopenedDialog.getByLabel("description")).toHaveValue("an e2e project")
  await expect(reopenedDialog.getByLabel("tags")).toHaveValue("alpha, beta")
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
