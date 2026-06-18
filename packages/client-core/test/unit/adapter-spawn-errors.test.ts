import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { tmpdir } from "node:os"
import { makeBunAdapter } from "@yodea/client-core/adapters/bun"
import { makeNodeAdapter } from "@yodea/client-core/adapters/node"

const dir = tmpdir()

describe("bun adapter spawn errors", () => {
  it("fails with BackendUnavailable when the binary does not exist", async () => {
    const adapter = makeBunAdapter({ backendCommand: ["/definitely/missing/yodea-server-xyz"] })
    const r = await Effect.runPromise(Effect.result(adapter.spawnBackend(dir)))
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") {
      expect(r.failure._tag).toBe("BackendUnavailable")
      expect(r.failure.reason).toContain("spawn failed")
    }
  })

  it("fails with BackendUnavailable when the command thunk throws", async () => {
    const adapter = makeBunAdapter({
      backendCommand: () => {
        throw new Error("YODEA_BACKEND_CMD must be a JSON array of strings")
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

describe("node adapter spawn errors", () => {
  it("fails with BackendUnavailable when the binary does not exist", async () => {
    const adapter = makeNodeAdapter({ backendCommand: ["definitely-missing-yodea-server-xyz"] })
    const r = await Effect.runPromise(Effect.result(adapter.spawnBackend(dir)))
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") {
      expect(r.failure._tag).toBe("BackendUnavailable")
      expect(r.failure.reason).toContain("spawn failed")
    }
  })

  it("fails with BackendUnavailable when the command thunk throws", async () => {
    const adapter = makeNodeAdapter({
      backendCommand: () => {
        throw new Error("YODEA_BACKEND_CMD must be a JSON array of strings")
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
