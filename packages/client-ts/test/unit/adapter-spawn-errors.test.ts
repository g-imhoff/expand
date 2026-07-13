import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { tmpdir } from "node:os"
import { makeNodeAdapter } from "../../adapters/node"

const dir = tmpdir()
const missingExecutable = "/definitely/missing/expand-server-xyz"

describe("node adapter spawn errors", () => {
  it("fails with BackendUnavailable when the binary does not exist", async () => {
    const adapter = makeNodeAdapter({ backendCommand: [missingExecutable] })
    const r = await Effect.runPromise(Effect.result(adapter.spawnBackend(dir)))
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") {
      expect(r.failure._tag).toBe("BackendUnavailable")
      expect(r.failure.reason).toContain("spawn failed")
    }
  })

  it("fails with BackendUnavailable when the backend command is empty", async () => {
    const adapter = makeNodeAdapter({ backendCommand: [] })
    const r = await Effect.runPromise(Effect.result(adapter.spawnBackend(dir)))
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") {
      expect(r.failure._tag).toBe("BackendUnavailable")
      expect(r.failure.reason).toContain("spawn failed: <empty>:")
    }
  })

  it("fails with BackendUnavailable when the command thunk throws", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: () => {
        throw new Error("EXPAND_BACKEND_CMD must be a JSON array of strings")
      }
    })
    const r = await Effect.runPromise(Effect.result(adapter.spawnBackend(dir)))
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") {
      expect(r.failure._tag).toBe("BackendUnavailable")
      expect(r.failure.reason).toContain("invalid backend command")
    }
  })
})
