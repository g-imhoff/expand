import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ProjectAlreadyExists, YodeaRpcs } from "@yodea/contracts/rpc"

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

describe("contracts/rpc payload validation", () => {
  const payloadOf = (tag: string) => YodeaRpcs.requests.get(tag)!.payloadSchema

  it("ProjectCreate accepts a kebab-case name", () => {
    const decoded = Schema.decodeUnknownSync(payloadOf("ProjectCreate"))({ name: "my-project-1", ensure: false })
    expect(decoded).toMatchObject({ name: "my-project-1" })
  })

  it("ProjectCreate rejects an empty name", () => {
    expect(() => Schema.decodeUnknownSync(payloadOf("ProjectCreate"))({ name: "", ensure: false })).toThrow()
  })

  it("ProjectCreate rejects an uppercase name", () => {
    expect(() => Schema.decodeUnknownSync(payloadOf("ProjectCreate"))({ name: "E2E", ensure: false })).toThrow()
  })

  it("ProjectCreate rejects a 65-char name", () => {
    expect(() =>
      Schema.decodeUnknownSync(payloadOf("ProjectCreate"))({ name: "a".repeat(65), ensure: false })
    ).toThrow()
  })

  it("ProjectRename rejects a non-UUID id", () => {
    expect(() => Schema.decodeUnknownSync(payloadOf("ProjectRename"))({ id: "ghost", name: "ok" })).toThrow()
    expect(
      Schema.decodeUnknownSync(payloadOf("ProjectRename"))({
        id: "00000000-0000-4000-8000-000000000000",
        name: "ok"
      })
    ).toBeDefined()
  })

  it("ProjectCreate rejects a directory longer than 4096 chars", () => {
    expect(() =>
      Schema.decodeUnknownSync(payloadOf("ProjectCreate"))({
        name: "ok",
        ensure: false,
        directory: `/${"x".repeat(4096)}`
      })
    ).toThrow()
  })
})
