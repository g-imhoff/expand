import { it } from "@effect/vitest"
import { NodePath } from "@effect/platform-node"
import { Effect } from "effect"
import { describe, expect } from "vitest"
import { defaultBackendEntry } from "@expand/desktop/main/runtime"

describe("desktop default backend entry", () => {
  it.effect("resolves the bundled main module path to apps/server/main.ts", () =>
    Effect.gen(function* () {
      const entry = yield* defaultBackendEntry(new URL("file:///repo/apps/desktop/out/main/index.mjs"))
      expect(entry).toBe("/repo/apps/server/main.ts")
    }).pipe(Effect.provide(NodePath.layer)))

  it.effect("resolves the source main module path to apps/server/main.ts", () =>
    Effect.gen(function* () {
      const entry = yield* defaultBackendEntry(new URL("file:///repo/apps/desktop/src/main/runtime.ts"))
      expect(entry).toBe("/repo/apps/server/main.ts")
    }).pipe(Effect.provide(NodePath.layer)))
})
