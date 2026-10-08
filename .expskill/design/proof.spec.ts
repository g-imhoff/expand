import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Schema } from "effect"
import { expect, test } from "@playwright/test"

for (const size of [
  { name: "compact", width: 390, height: 700 },
  { name: "intermediate", width: 768, height: 700 },
  { name: "wide", width: 980, height: 700 }
]) {
  test(`${size.name}: real sidebar with production context`, ({ page }, testInfo) => Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    yield* Effect.promise(() => page.setViewportSize({ width: size.width, height: size.height }))
    yield* Effect.promise(() => page.goto("/"))
    yield* Effect.promise(() => expect(page.getByRole("heading", { name: "Project inbox" })).toBeVisible())

    if (size.name === "compact") {
      yield* Effect.promise(() => expect(page.getByRole("dialog", { name: "Sidebar" })).toHaveCount(0))
      yield* Effect.promise(() => page.screenshot({ path: testInfo.outputPath("closed.png") }))
      yield* Effect.promise(() => page.keyboard.press("Control+b"))
      yield* Effect.promise(() => expect(page.getByRole("dialog", { name: "Sidebar" })).toBeVisible())
      yield* Effect.promise(() => expect.poll(() => page.getByRole("dialog", { name: "Sidebar" }).evaluate((sidebar) => Math.round(sidebar.getBoundingClientRect().x))).toBe(0))
    }

    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Active project: expand" })).toBeVisible())
    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Switch device, active: Workstation" })).toBeVisible())
    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Inspect reconnect behavior, unread" })).toBeVisible())
    yield* Effect.promise(() => page.screenshot({ path: testInfo.outputPath("light.png") }))

    const observations = yield* Effect.promise(() => page.evaluate(() => {
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
    }))
    expect(observations.innerWidth).toBe(size.width)
    expect(observations.innerHeight).toBe(size.height)
    expect(observations.documentWidth).toBeLessThanOrEqual(size.width)
    expect(observations.sidebar.width).toBeGreaterThan(0)
    expect(observations.sidebar.height).toBeGreaterThan(0)
    expect(observations.sidebarPrimary).not.toBe("")
    expect(observations.mobile).toBe(size.name === "compact")

    yield* Effect.promise(() => page.getByRole("switch", { name: "Show unread conversations only" }).click())
    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Check connection settings", exact: true })).toHaveCount(0))
    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Inspect reconnect behavior, unread" })).toBeVisible())
    yield* Effect.promise(() => page.getByRole("switch", { name: "Show unread conversations only" }).click())
    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Check connection settings", exact: true })).toBeVisible())

    yield* Effect.promise(() => page.getByRole("button", { name: "Active project: expand" }).click())
    yield* Effect.promise(() => page.getByRole("menuitem", { name: /docs-site/ }).click())
    yield* Effect.promise(() => expect(page.getByRole("button", { name: "Active project: docs-site" })).toBeVisible())

    yield* Effect.promise(() => page.evaluate(() => document.documentElement.classList.add("dark")))
    yield* Effect.promise(() => page.screenshot({ path: testInfo.outputPath("dark.png") }))
    const darkPrimary = yield* Effect.promise(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sidebar-primary").trim()))
    expect(darkPrimary).not.toBe(observations.sidebarPrimary)
    expect(errors).toEqual([])

    const path = testInfo.outputPath("observations.json")
    yield* fs.writeFileString(path, Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ scenario: "sidebar-two-worktrees-unread", requested: size, observed: observations, darkPrimary, errors }) + "\n")
    yield* Effect.promise(() => testInfo.attach("runtime-observations", { path, contentType: "application/json" }))
  }).pipe(Effect.provide(NodeServices.layer))))
}
