import { expect } from "@playwright/test"
import { Effect } from "effect"
import { testEffect } from "./effect-test"
import { launchApp, createProject } from "./helpers"

testEffect("renames a project and the list reflects the new name", (_fixtures, testInfo) => Effect.gen(function* () {
  const { win } = yield* launchApp(testInfo.config.configFile ?? "")
  yield* createProject(win, "e2e-rename-src")

  const list = win.getByTestId("project-list")
  yield* Effect.tryPromise(() =>
    list.getByRole("listitem").filter({ hasText: "e2e-rename-src" }).getByRole("button", { name: "Rename" }).click())
  yield* Effect.tryPromise(() => win.getByLabel("new project name").fill("e2e-rename-dst"))
  yield* Effect.tryPromise(() =>
    win.getByRole("dialog").getByRole("button", { name: "Rename" }).click())

  yield* Effect.tryPromise(() => expect(list).toContainText("e2e-rename-dst"))
  yield* Effect.tryPromise(() => expect(list).not.toContainText("e2e-rename-src"))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))
}))
