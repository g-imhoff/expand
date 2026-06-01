import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ProjectAlreadyExists } from "@yodea/contracts/rpc"

describe("contracts/rpc ProjectAlreadyExists", () => {
  it("is a tagged error carrying the conflicting name", () => {
    const e = new ProjectAlreadyExists({ name: "foo" })
    expect(e._tag).toBe("ProjectAlreadyExists")
    expect(e.name).toBe("foo")
  })

  it("encodes to a tagged wire object", () => {
    const enc = Schema.encodeUnknownSync(ProjectAlreadyExists)(new ProjectAlreadyExists({ name: "foo" }))
    expect(enc).toMatchObject({ _tag: "ProjectAlreadyExists", name: "foo" })
  })
})
