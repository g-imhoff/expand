import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DomainEventFromJson, SessionCreated } from "@yodea/shared/events"

describe("DomainEvent", () => {
  it("constructs SessionCreated with an auto-filled _tag", () => {
    const e = SessionCreated.make({
      sessionId: "s1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    expect(e._tag).toBe("SessionCreated")
    expect(e.title).toBe("First")
  })

  it("roundtrips through JSON text", () => {
    const e = SessionCreated.make({
      sessionId: "s1",
      title: "First",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    const json = Schema.encodeSync(DomainEventFromJson)(e)
    expect(typeof json).toBe("string")
    expect(Schema.decodeUnknownSync(DomainEventFromJson)(json)).toEqual(e)
  })
})
