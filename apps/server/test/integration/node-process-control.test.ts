import { layer as effectLayer } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { expect } from "vitest"
import { ProcessControl } from "@expand/contracts/process-control"
import { ProcessServices } from "@expand/server/runtime/node-process-control"

effectLayer(ProcessServices.layer, { excludeTestServices: true, timeout: "2 minutes" })("node process incarnation", (test) => {
  test.effect("identifies the current process incarnation on this platform", () =>
    Effect.gen(function*() {
      const control = yield* ProcessControl
      const identity = yield* control.currentIdentity()
      const observed = yield* control.identify(control.currentPid)

      expect(observed.status).toBe("alive")
      if (observed.status === "alive") expect(observed.identity).toBe(identity)
    }))

  test.effect("reports a missing pid as dead", () =>
    Effect.gen(function*() {
      const control = yield* ProcessControl

      expect(yield* control.identify(2_147_483_647)).toEqual({ status: "dead" })
    }))

  test.effect("observes a defined incarnation wherever procfs is available", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const control = yield* ProcessControl
      if (!(yield* fs.exists("/proc/self/stat"))) return
      const identity = yield* control.currentIdentity()

      expect(identity).toBeDefined()
    }))
})
