import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Data, Effect, Path } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

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
  (cwd: string, command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make(command, args, {
        cwd,
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
  function*(root: string, mode: DesktopMode) {
    const path = yield* Path.Path
    const cwd = path.join(root, "apps", "desktop")
    if (mode === "dev") {
      return yield* runCommand(cwd, "electron-vite", ["dev", "-w"])
    }
    yield* runCommand(cwd, "electron-vite", ["build"])
    if (mode === "e2e") {
      yield* runCommand(cwd, "playwright", ["test", "-c", "e2e/playwright.config.ts"])
    }
  }
)

const atRoot = (mode: DesktopMode) => Path.Path.pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../", import.meta.url))),
  Effect.flatMap((root) => runDesktopCommand(root, mode))
)

const command = Command.make("desktop-command").pipe(Command.withSubcommands([
  Command.make("dev", {}, () => atRoot("dev")),
  Command.make("build", {}, () => atRoot("build")),
  Command.make("e2e", {}, () => atRoot("e2e"))
]))

const program = Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer))

if (import.meta.main) {
  NodeRuntime["runMain"](program)
}
