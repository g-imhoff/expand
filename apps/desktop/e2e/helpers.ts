import { _electron as electron, type Page } from "@playwright/test"
import { Clock, Effect, FileSystem, Path, Schedule, Schema } from "effect"

export interface LaunchAppDependencies {
  readonly launch: typeof electron.launch
}

export const launchApp = Effect.fn("DesktopE2E.launchApp")(function* (
  dependencies: LaunchAppDependencies = liveDependencies
) {
  yield* Clock.currentTimeMillis
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataHome = yield* fs.makeTempDirectoryScoped({ prefix: "expand-e2e-home-" })
  const executablePath = path.resolve("apps", "desktop", "out", "main", "index.mjs")
  const args = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Literal("--no-sandbox"), Schema.String, Schema.Literal("--data-dir"), Schema.String])
  )(["--no-sandbox", executablePath, "--data-dir", dataHome])
  const app = yield* Effect.acquireRelease(
    Effect.tryPromise(() => dependencies.launch({ args: [...args] })),
    (launched) =>
      Effect.tryPromise(() => launched.close()).pipe(
        Effect.retry({ schedule: closeSchedule, times: 2 }),
        Effect.orDie
      )
  )
  const win = yield* Effect.tryPromise(() => app.firstWindow())
  yield* Effect.tryPromise(() => win.getByText("Projects (").waitFor())
  return { win }
})

export const createProject = Effect.fn("DesktopE2E.createProject")(function* (win: Page, name: string) {
  yield* Effect.tryPromise(() => win.getByLabel("project name").fill(name))
  yield* Effect.tryPromise(() => win.getByRole("button", { name: "Create" }).click())
  yield* Effect.tryPromise(() =>
    win.getByTestId("project-list").getByText(name, { exact: true }).waitFor())
})

export const openPalette = Effect.fn("DesktopE2E.openPalette")(function* (win: Page) {
  yield* Effect.tryPromise(() => win.keyboard.press("ControlOrMeta+Shift+P"))
  yield* Effect.tryPromise(() => win.getByPlaceholder("Type a project name or search…").waitFor())
})

const liveDependencies: LaunchAppDependencies = {
  launch: electron.launch.bind(electron)
}

const closeSchedule = Schedule.spaced("25 millis")
