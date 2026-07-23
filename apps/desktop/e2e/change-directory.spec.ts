import { expect } from "@playwright/test"
import { Effect, FileSystem } from "effect"
import { testEffect } from "./effect-test"
import { launchApp, createProject } from "./helpers"

testEffect("sets a project directory without surfacing an error", Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "expand-e2e-project-" })
  const { win } = yield* launchApp()
  yield* createProject(win, "e2e-cd")

  const row = win.getByTestId("project-list").getByRole("listitem").filter({ hasText: "e2e-cd" })
  yield* Effect.tryPromise(() => row.getByRole("button", { name: "Change directory" }).click())
  yield* Effect.tryPromise(() => win.getByLabel("project directory").fill(directory))
  yield* Effect.tryPromise(() => win.getByRole("dialog").getByRole("button", { name: "Save" }).click())

  yield* Effect.tryPromise(() => expect(win.getByRole("dialog")).toHaveCount(0))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))

  yield* Effect.tryPromise(() => row.getByRole("button", { name: "Change directory" }).click())
  yield* Effect.tryPromise(() => expect(win.getByLabel("project directory")).toHaveValue(directory))
  yield* Effect.tryPromise(() => expect(win.locator("[role=alert]")).toHaveCount(0))
}))
