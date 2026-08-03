import * as NodePlatform from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Layer, Effect, Fiber, Path } from "effect"
import { describe, expect, vi } from "vitest"
import { processSpawnerFixture } from "../test/support/process-spawner"
import { DesktopCommandError, runDesktopCommand, runDesktopCommandAtRoot } from "./desktop-command"

const commandDetails = (fixture: ReturnType<typeof processSpawnerFixture>) => fixture.records.map(({ command }) => {
  expect(command._tag).toBe("StandardCommand")
  return command._tag === "StandardCommand"
    ? { command: command.command, args: command.args, cwd: command.options.cwd, env: command.options.env, stdin: command.options.stdin, stdout: command.options.stdout, stderr: command.options.stderr }
    : undefined
})

describe("desktop command", () => {
  it.effect("resolves one tagged build identity and transports it to the desktop build", () => {
    const fixture = processSpawnerFixture([0, 0], { stdout: ["v3.4.5\n", ""] })
    return runDesktopCommandAtRoot("/repo", "build").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, Path.layer)),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([
          {
            command: "git",
            args: ["tag", "--points-at", "HEAD", "--list", "v*"],
            cwd: "/repo",
            env: undefined,
            stdin: undefined,
            stdout: undefined,
            stderr: undefined
          },
          {
            command: "electron-vite",
            args: ["build"],
            cwd: "/repo/apps/desktop",
            env: { EXPAND_APP_VERSION: "3.4.5" },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit"
          }
        ])
        expect(fixture.records.every(({ released }) => released)).toBe(true)
      }))
    )
  })

  it.effect("runs dev with the exact electron-vite arguments and desktop cwd", () => {
    const fixture = processSpawnerFixture([0])
    return runDesktopCommand("/repo", "dev", "1.2.3").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, Path.layer)),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([{
          command: "electron-vite",
          args: ["dev", "-w"],
          cwd: "/repo/apps/desktop",
          env: { EXPAND_APP_VERSION: "1.2.3" },
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
    const environment = (Reflect.get(globalThis, "process") as NodeJS.Process).env
    const parentVersion = environment.EXPAND_APP_VERSION
    return runDesktopCommand("/repo", "build", "1.2.3").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, Path.layer)),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([{
          command: "electron-vite",
          args: ["build"],
          cwd: "/repo/apps/desktop",
          env: { EXPAND_APP_VERSION: "1.2.3" },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit"
        }])
        expect(environment.EXPAND_APP_VERSION).toBe(parentVersion)
      }))
    )
  })

  it.effect("runs e2e as build followed by Playwright with exact arguments", () => {
    const fixture = processSpawnerFixture([0, 0])
    return runDesktopCommand("/repo", "e2e", "1.2.3").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, Path.layer)),
      Effect.tap(() => Effect.sync(() => {
        expect(commandDetails(fixture)).toEqual([
          {
            command: "electron-vite",
            args: ["build"],
            cwd: "/repo/apps/desktop",
            env: { EXPAND_APP_VERSION: "1.2.3" },
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit"
          },
          {
            command: "playwright",
            args: ["test", "-c", "e2e/playwright.config.ts"],
            cwd: "/repo/apps/desktop",
            env: { EXPAND_APP_VERSION: "1.2.3" },
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
    return runDesktopCommand("/repo", "e2e", "1.2.3").pipe(
      Effect.provide(Layer.mergeAll(fixture.layer, Path.layer)),
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
      const fiber = yield* runDesktopCommand("/repo", "dev", "1.2.3").pipe(
        Effect.provide(Layer.mergeAll(fixture.layer, Path.layer)),
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
