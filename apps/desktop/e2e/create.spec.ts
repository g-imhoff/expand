import { expect } from "@playwright/test"
import { Effect } from "effect"
import { testEffect } from "./effect-test"
import { launchApp, createProject } from "./helpers"

testEffect("creates a project and shows it live", Effect.gen(function* () {
  const { win } = yield* launchApp()
  yield* Effect.tryPromise(() => expect(win.getByText("Projects (")).toBeVisible())
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))

  yield* createProject(win, "e2e-alpha")
  yield* Effect.tryPromise(() => expect(win.getByTestId("project-list")).toContainText("e2e-alpha"))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))
}))
