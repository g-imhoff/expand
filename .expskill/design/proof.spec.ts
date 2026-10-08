import { writeFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

for (const size of [
  { name: "compact", width: 390, height: 700 },
  { name: "intermediate", width: 768, height: 700 },
  { name: "wide", width: 980, height: 700 }
]) {
  test(`${size.name}: real sidebar with production context`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await page.setViewportSize({ width: size.width, height: size.height })
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Project inbox" })).toBeVisible()

    if (size.name === "compact") {
      await expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath("closed.png") })
      await page.keyboard.press("Control+b")
      await expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible()
    }

    await expect(page.getByRole("button", { name: "Active project: expand" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Switch device, active: Workstation" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Inspect reconnect behavior, unread" })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("light.png") })

    const observations = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>("[data-mobile=true], [data-slot=sidebar-container]")
      if (sidebar === null) throw new Error("The production sidebar is missing")
      const bounds = sidebar.getBoundingClientRect()
      const style = getComputedStyle(sidebar)
      return {
        innerWidth,
        innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        sidebar: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        fontFamily: style.fontFamily,
        backgroundColor: style.backgroundColor,
        sidebarPrimary: getComputedStyle(document.documentElement).getPropertyValue("--sidebar-primary").trim(),
        mobile: sidebar.dataset.mobile === "true"
      }
    })
    expect(observations.innerWidth).toBe(size.width)
    expect(observations.innerHeight).toBe(size.height)
    expect(observations.sidebar.width).toBeGreaterThan(0)
    expect(observations.sidebar.height).toBeGreaterThan(0)
    expect(observations.sidebarPrimary).not.toBe("")
    expect(observations.mobile).toBe(size.name === "compact")

    await page.getByRole("switch", { name: "Show unread conversations only" }).click()
    await expect(page.getByRole("button", { name: "Check connection settings", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Inspect reconnect behavior, unread" })).toBeVisible()
    await page.getByRole("switch", { name: "Show unread conversations only" }).click()
    await expect(page.getByRole("button", { name: "Check connection settings", exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Active project: expand" }).click()
    await page.getByRole("menuitem", { name: /docs-site/ }).click()
    await expect(page.getByRole("button", { name: "Active project: docs-site" })).toBeVisible()

    await page.evaluate(() => document.documentElement.classList.add("dark"))
    await page.screenshot({ path: testInfo.outputPath("dark.png") })
    const darkPrimary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-primary").trim())
    expect(darkPrimary).not.toBe(observations.sidebarPrimary)
    expect(errors).toEqual([])

    const path = testInfo.outputPath("observations.json")
    await writeFile(path, JSON.stringify({ scenario: "sidebar-two-worktrees-unread", requested: size, observed: observations, darkPrimary, errors }, null, 2) + "\n")
    await testInfo.attach("runtime-observations", { path, contentType: "application/json" })
  })
}
