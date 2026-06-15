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

// Payloads carry plain strings: the wire deliberately does NOT validate names,
// tags, ids, or directory length. That is the server's job at the ingestion
// boundary (see apps/server use-cases + packages/contracts project verbs). These
// tests pin that the wire accepts raw strings, including ones the server rejects.
describe("contracts/rpc payloads are plain strings (validation is server-side)", () => {
  const payloadOf = (tag: string) => YodeaRpcs.requests.get(tag)!.payloadSchema

  it("ProjectCreate accepts any string name, including ones the server will reject", () => {
    const create = payloadOf("ProjectCreate")
    expect(Schema.decodeUnknownSync(create)({ name: "my-project-1", ensure: false })).toMatchObject({ name: "my-project-1" })
    expect(Schema.decodeUnknownSync(create)({ name: "E2E", ensure: false })).toMatchObject({ name: "E2E" })
    expect(Schema.decodeUnknownSync(create)({ name: "", ensure: false })).toMatchObject({ name: "" })
    expect(Schema.decodeUnknownSync(create)({ name: "a".repeat(65), ensure: false })).toMatchObject({ name: "a".repeat(65) })
  })

  it("ProjectCreate accepts an arbitrarily long directory string", () => {
    const long = `/${"x".repeat(4096)}`
    expect(Schema.decodeUnknownSync(payloadOf("ProjectCreate"))({ name: "ok", ensure: false, directory: long }))
      .toMatchObject({ directory: long })
  })

  it("ProjectRename accepts a non-UUID id (existence is checked by the server)", () => {
    expect(Schema.decodeUnknownSync(payloadOf("ProjectRename"))({ id: "ghost", name: "ok" })).toMatchObject({ id: "ghost" })
  })
})
