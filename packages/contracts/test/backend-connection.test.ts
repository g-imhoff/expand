import { describe, expect, it } from "vitest"
import { normalizeRemoteUrl, BackendConnectionInvalid } from "@expand/contracts/backend-connection"

describe("normalizeRemoteUrl", () => {
  it("converts schemes and strips query and hash", () => {
    expect(normalizeRemoteUrl("ws://127.0.0.1:4123/rpc")).toBe("ws://127.0.0.1:4123/rpc")
    expect(normalizeRemoteUrl("http://127.0.0.1:4123/rpc")).toBe("ws://127.0.0.1:4123/rpc")
    expect(normalizeRemoteUrl("https://example.com/rpc")).toBe("wss://example.com/rpc")
    expect(normalizeRemoteUrl("example.com/rpc")).toBe("wss://example.com/rpc")
    expect(normalizeRemoteUrl("ws://example.com/rpc?token=abc#frag")).toBe("ws://example.com/rpc")
  })

  it("rejects unsupported and malformed schemes", () => {
    expect(() => normalizeRemoteUrl("ftp://example.com/rpc")).toThrowError(BackendConnectionInvalid)
    expect(() => normalizeRemoteUrl("ws:/evil")).toThrowError(BackendConnectionInvalid)
  })
})
