import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Data, Effect, Path } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { resolveAppVersion, resolveBuildAppVersion } from "./app-version"

export type DesktopMode = "dev" | "build" | "e2e"

export class DesktopCommandError extends Data.TaggedError("DesktopCommandError")<{
  readonly command: string
  readonly exitCode: number
}> {}

export class DesktopProcessError extends Data.TaggedError("DesktopProcessError")<{
  readonly command: string
  readonly cause: unknown
}> {}

const runCommand = Effect.fn("DesktopCommand.runCommand")(
  (cwd: string, command: string, args: ReadonlyArray<string>, appVersion: string) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
        cwd,
        env: { EXPAND_APP_VERSION: appVersion },
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })).pipe(Effect.mapError((cause) => new DesktopProcessError({ command, cause })))
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => new DesktopProcessError({ command, cause }))
      )
      if (exitCode !== 0) {
        return yield* new DesktopCommandError({ command, exitCode })
      }
    }))
)

export const runDesktopCommand = Effect.fn("DesktopCommand.run")(
  function*(root: string, mode: DesktopMode, appVersion: string) {
    const path = yield* Path.Path
    const cwd = path.join(root, "apps", "desktop")
    if (mode === "dev") {
      return yield* runCommand(cwd, "electron-vite", ["dev", "-w"], appVersion)
    }
    yield* runCommand(root, "tsx", ["scripts/desktop-backend.ts"], appVersion)
    yield* runCommand(cwd, "electron-vite", ["build"], appVersion)
    const builderMode = mode === "build" ? ["--publish", "never"] : ["--dir"]
    yield* runCommand(
      cwd,
      "electron-builder",
      [...builderMode, `--config.extraMetadata.version=${appVersion}`],
      appVersion
    )
    if (mode === "e2e") {
      yield* runCommand(cwd, "playwright", ["test", "-c", "e2e/playwright.config.ts"], appVersion)
    }
  }
)

export const runDesktopCommandAtRoot = Effect.fn("DesktopCommand.runAtRoot")(
  function*(root: string, mode: DesktopMode) {
    const appVersion = yield* mode === "dev"
      ? resolveAppVersion(root, "development")
      : resolveBuildAppVersion(root)
    yield* runDesktopCommand(root, mode, appVersion)
  }
)

const atRoot = (mode: DesktopMode) => Effect.gen(function*() {
  const path = yield* Path.Path
  const root = yield* path.fromFileUrl(new URL("../", import.meta.url))
  yield* runDesktopCommandAtRoot(root, mode)
})

const command = Command.make("desktop-command").pipe(Command.withSubcommands([
  Command.make("dev", {}, () => atRoot("dev")),
  Command.make("build", {}, () => atRoot("build")),
  Command.make("e2e", {}, () => atRoot("e2e"))
]))

const program = Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer))

if (import.meta.main) {
  NodeRuntime["runMain"](program)
}
