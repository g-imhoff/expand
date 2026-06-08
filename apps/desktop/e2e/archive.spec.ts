import { test, expect } from "@playwright/test"
import { launchApp, createProject, openPalette } from "./helpers"

test("archives then restores a project via the command palette", async () => {
  const { app, win } = await launchApp()
  await createProject(win, "e2e-arch")
  const list = win.getByTestId("project-list")

  // Archive via palette.
  await openPalette(win)
  await win.getByPlaceholder("Type a project name or search…").fill("e2e-arch")
  await win.getByRole("option", { name: /Archive “e2e-arch”/ }).click()
  await expect(list).not.toContainText("e2e-arch")

  // Restore via palette (archived projects still appear, labelled "(archived)").
  await openPalette(win)
  await win.getByPlaceholder("Type a project name or search…").fill("e2e-arch")
  await win.getByRole("option", { name: /Restore “e2e-arch” \(archived\)/ }).click()
  await expect(list).toContainText("e2e-arch")
  await expect(win.locator("[role=alert]")).toHaveCount(0)
  await app.close()
})
