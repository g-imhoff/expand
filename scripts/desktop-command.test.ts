import * as NodePlatform from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Fiber, Path } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../test/support/process-spawner"
import { DesktopCommandError, runDesktopCommand } from "./desktop-command"

const commandDetails = (fixture: ReturnType<typeof processSpawnerFixture>) => fixture.records.map(({ command }) => {
  expect(command._tag).toBe("StandardCommand")
  return command._tag === "StandardCommand"
    ? { command: command.command, args: command.args, cwd: command.options.cwd, stdin: command.options.stdin, stdout: command.options.stdout, stderr: command.options.stderr }
    : undefined
})

describe("desktop command", () => {
  it.effect("runs dev with the exact electron-vite arguments and desktop cwd", () => {
    const fixture = processSpawnerFixture([0])
    return runDesktopCommand("/repo", "dev").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(Path.layer),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([{
          command: "electron-vite",
          args: ["dev", "-w"],
          cwd: "/repo/apps/desktop",
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit"
        }])
        expect(fixture.records[0]?.released).toBe(true)
      }))
    )
  })

  it.effect("runs build with the exact electron-vite arguments and desktop cwd", () => {
    const fixture = processSpawnerFixture([0])
    return runDesktopCommand("/repo", "build").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(Path.layer),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([{
          command: "electron-vite",
          args: ["build"],
          cwd: "/repo/apps/desktop",
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit"
        }])
      }))
    )
  })

  it.effect("runs e2e as build followed by Playwright with exact arguments", () => {
    const fixture = processSpawnerFixture([0, 0])
    return runDesktopCommand("/repo", "e2e").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(Path.layer),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([
          {
            command: "electron-vite",
            args: ["build"],
            cwd: "/repo/apps/desktop",
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit"
          },
          {
            command: "playwright",
            args: ["test", "-c", "e2e/playwright.config.ts"],
            cwd: "/repo/apps/desktop",
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit"
          }
        ])
      }))
    )
  })

  it.effect("tags nonzero exits and does not continue e2e", () => {
    const fixture = processSpawnerFixture([6])
    return runDesktopCommand("/repo", "e2e").pipe(
      Effect.provide(fixture.layer),
      Effect.provide(Path.layer),
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => {
        expect(error).toEqual(new DesktopCommandError({ command: "electron-vite", exitCode: 6 }))
        expect(fixture.records).toHaveLength(1)
      }))
    )
  })

  it.effect("releases a running child when interrupted", () => {
    const fixture = processSpawnerFixture([], { neverExitAt: 0 })
    return Effect.gen(function*() {
      const fiber = yield* runDesktopCommand("/repo", "dev").pipe(
        Effect.provide(fixture.layer),
        Effect.provide(Path.layer),
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(fixture.records).toHaveLength(1)
      expect(fixture.records[0]?.released).toBe(false)

      yield* Fiber.interrupt(fiber)

      expect(fixture.records[0]?.released).toBe(true)
    })
  })

  it.effect("imports without running the CLI", () =>
    Effect.gen(function*() {
      vi.resetModules()
      const runMain = vi.fn()
      vi.doMock("@effect/platform-node", () => ({
        ...NodePlatform,
        NodeRuntime: { ...NodePlatform.NodeRuntime, runMain }
      }))
      const module = yield* Effect.promise(() => import("./desktop-command"))
      expect(module.runDesktopCommand).toBeTypeOf("function")
      expect(runMain).not.toHaveBeenCalled()
      vi.doUnmock("@effect/platform-node")
      vi.resetModules()
    }))
})
