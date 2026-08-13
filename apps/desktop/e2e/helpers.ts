import { _electron as electron, type Page } from "@playwright/test"
import { Clock, Effect, FileSystem, Path, Schedule, Schema } from "effect"

export interface LaunchAppDependencies {
  readonly launch: typeof electron.launch
  readonly platform?: NodeJS.Platform
  readonly stageDistribution?: boolean
}

export const resolveDesktopDistribution = Effect.fn("DesktopE2E.resolveDesktopDistribution")(
  function*(desktopDirectory: string, platform: "linux" | "darwin" | "win32") {
    const path = yield* Path.Path
    if (platform === "darwin") {
      const directory = path.resolve(desktopDirectory, "release", "mac", "Expand.app")
      return {
        directory,
        executable: path.join(directory, "Contents", "MacOS", "Expand")
      }
    }
    if (platform === "win32") {
      const directory = path.resolve(desktopDirectory, "release", "win-unpacked")
      return { directory, executable: path.join(directory, "Expand.exe") }
    }
    const directory = path.resolve(desktopDirectory, "release", "linux-unpacked")
    return { directory, executable: path.join(directory, "expand") }
  }
)

export const launchApp = Effect.fn("DesktopE2E.launchApp")(function* (
  configFile: string,
  dependencies: LaunchAppDependencies = liveDependencies
) {
  yield* Clock.currentTimeMillis
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolvedConfigFile = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(configFile)
  const platform = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["linux", "darwin", "win32"])
  )(dependencies.platform ?? process.platform)
  const dataHome = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "expand-e2e-home-" }),
    (directory) => Effect.gen(function*() {
      const ownershipFiles = ["server.json", "server.json.lock", "backend.lock"]
      yield* Effect.forEach(ownershipFiles, (file) => fs.exists(path.join(directory, file))).pipe(
        Effect.filterOrFail((present) => present.every((exists) => !exists)),
        Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 200 })
      )
      yield* fs.remove(directory, { recursive: true })
    }).pipe(Effect.orDie)
  )
  const desktopDirectory = path.resolve(path.dirname(resolvedConfigFile), "..")
  const sourceDistribution = yield* resolveDesktopDistribution(desktopDirectory, platform)
  let distribution = sourceDistribution
  if (dependencies.stageDistribution === true) {
    const stagingRoot = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "expand-e2e-app-" }),
      (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.orDie)
    )
    const stagedDirectory = path.join(stagingRoot, "app")
    yield* fs.copy(sourceDistribution.directory, stagedDirectory)
    distribution = {
      directory: stagedDirectory,
      executable: path.join(
        stagedDirectory,
        path.relative(sourceDistribution.directory, sourceDistribution.executable)
      )
    }
  }
  const args = yield* Schema.decodeUnknownEffect(
    Schema.Tuple([Schema.Literal("--no-sandbox"), Schema.Literal("--data-dir"), Schema.String])
  )(["--no-sandbox", "--data-dir", dataHome])
  const app = yield* Effect.acquireRelease(
    Effect.tryPromise(() => dependencies.launch({
      args: [...args],
      cwd: distribution.directory,
      executablePath: distribution.executable
    })),
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
  launch: electron.launch.bind(electron),
  stageDistribution: true
}

const closeSchedule = Schedule.spaced("25 millis")
