import { expect } from "@playwright/test"
import { Effect } from "effect"
import { testEffect } from "./effect-test"
import { launchApp, createProject, openPalette } from "./helpers"

testEffect("edits project metadata via the command palette", (_fixtures, testInfo) => Effect.gen(function* () {
  const { win } = yield* launchApp(testInfo.config.configFile ?? "")
  yield* createProject(win, "e2e-meta")

  yield* openPalette(win)
  yield* Effect.tryPromise(() =>
    win.getByPlaceholder("Type a project name or search…").fill("edit e2e-meta"))
  const editOption = win.getByRole("option", { name: /Edit metadata “e2e-meta”/ })
  yield* Effect.tryPromise(() => editOption.scrollIntoViewIfNeeded())
  yield* Effect.tryPromise(() => editOption.click())

  const dialog = win.getByRole("dialog")
  yield* Effect.tryPromise(() => dialog.getByLabel("description").fill("an e2e project"))
  yield* Effect.tryPromise(() => dialog.getByLabel("tags").fill("alpha, beta"))
  yield* Effect.tryPromise(() => dialog.getByRole("button", { name: "Save" }).click())

  yield* Effect.tryPromise(() => expect(win.getByRole("dialog")).toHaveCount(0))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))

  yield* openPalette(win)
  yield* Effect.tryPromise(() =>
    win.getByPlaceholder("Type a project name or search…").fill("edit e2e-meta"))
  const reopened = win.getByRole("option", { name: /Edit metadata “e2e-meta”/ })
  yield* Effect.tryPromise(() => reopened.scrollIntoViewIfNeeded())
  yield* Effect.tryPromise(() => reopened.click())
  const reopenedDialog = win.getByRole("dialog")
  yield* Effect.tryPromise(() =>
    expect(reopenedDialog.getByLabel("description")).toHaveValue("an e2e project"))
  yield* Effect.tryPromise(() =>
    expect(reopenedDialog.getByLabel("tags")).toHaveValue("alpha, beta"))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))
}))
