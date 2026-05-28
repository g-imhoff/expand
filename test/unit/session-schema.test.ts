import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { Session } from "@yodea/shared/session"

describe("Session schema", () => {
  it("decodes a well-formed session", () => {
    const s = Schema.decodeUnknownSync(Session)({
      id: "s1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(s.id).toBe("s1")
  })

  it("rejects a session missing a field", () => {
    expect(() => Schema.decodeUnknownSync(Session)({ id: "s1" })).toThrow()
  })
})
