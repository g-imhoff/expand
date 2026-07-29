import { expect } from "@playwright/test"
import { Effect } from "effect"
import { testEffect } from "./effect-test"
import { launchApp, createProject, openPalette } from "./helpers"

testEffect("archives then restores a project via the command palette", (_fixtures, testInfo) => Effect.gen(function* () {
  const { win } = yield* launchApp(testInfo.config.configFile ?? "")
  yield* createProject(win, "e2e-arch")
  const list = win.getByTestId("project-list")

  yield* openPalette(win)
  yield* Effect.tryPromise(() => win.getByPlaceholder("Type a project name or search…").fill("e2e-arch"))
  yield* Effect.tryPromise(() => win.getByRole("option", { name: /Archive “e2e-arch”/ }).click())
  yield* Effect.tryPromise(() => expect(list).not.toContainText("e2e-arch"))

  yield* openPalette(win)
  yield* Effect.tryPromise(() => win.getByPlaceholder("Type a project name or search…").fill("e2e-arch"))
  yield* Effect.tryPromise(() => win.getByRole("option", { name: /Restore “e2e-arch” \(archived\)/ }).click())
  yield* Effect.tryPromise(() => expect(list).toContainText("e2e-arch"))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))
}))
