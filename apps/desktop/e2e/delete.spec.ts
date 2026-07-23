import { expect } from "@playwright/test"
import { Effect } from "effect"
import { testEffect } from "./effect-test"
import { launchApp, createProject } from "./helpers"

testEffect("deletes a project and removes it from the live list", Effect.gen(function* () {
  const { win } = yield* launchApp()
  yield* createProject(win, "e2e-del")

  const list = win.getByTestId("project-list")
  yield* Effect.tryPromise(() =>
    list.getByRole("listitem").filter({ hasText: "e2e-del" }).getByRole("button", { name: "Delete" }).click())
  yield* Effect.tryPromise(() =>
    win.getByRole("dialog").getByRole("button", { name: "Delete" }).click())

  yield* Effect.tryPromise(() => expect(list).not.toContainText("e2e-del"))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))
}))
