import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Exit, Path } from "effect"
import { describe, expect } from "vitest"
import { runCommand } from "../support/effect-process"

describe("no dead code", () => {
  it.live("knip finds no unused files, exports, types, or dependencies", () =>
    Effect.gen(function*() {
      const path = yield* Path.Path
      const result = yield* runCommand("npm", ["exec", "--", "knip", "--no-progress"], {
        cwd: path.resolve(".")
      }).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(true)
      if (Exit.isFailure(result)) return
      const output = `${result.value.stdout}\n${result.value.stderr}`.trim()
      expect(
        result.value.exitCode,
        output.length > 0
          ? `knip reported dead code (delete it, un-export it, or justify in knip.jsonc):\n\n${output}`
          : `knip failed to run (status ${String(result.value.exitCode)})`
      ).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer)), 120_000)
})
