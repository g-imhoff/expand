import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { ProjectAlreadyExists, ExpandRpcs } from "@expand/contracts/rpc"

describe("contracts/rpc ProjectAlreadyExists", () => {
  it("is a tagged error carrying the conflicting name", () => {
    const error = new ProjectAlreadyExists({ name: "foo" })
    expect(error._tag).toBe("ProjectAlreadyExists")
    expect(error.name).toBe("foo")
  })

  it.effect("encodes to a tagged wire object", () =>
    Schema.encodeUnknownEffect(ProjectAlreadyExists)(new ProjectAlreadyExists({ name: "foo" })).pipe(
      Effect.tap((encoded) => Effect.sync(() =>
        expect(encoded).toMatchObject({ _tag: "ProjectAlreadyExists", name: "foo" })
      ))
    ))
})

describe("contracts/rpc payloads are plain strings (validation is server-side)", () => {
  const payloadOf = (tag: string) => ExpandRpcs.requests.get(tag)!.payloadSchema

  it.effect("ProjectCreate accepts any string name, including ones the server will reject", () =>
    Effect.gen(function*() {
      const create = payloadOf("ProjectCreate")
      expect(yield* Schema.decodeUnknownEffect(create)({ name: "my-project-1", ensure: false }))
        .toMatchObject({ name: "my-project-1" })
      expect(yield* Schema.decodeUnknownEffect(create)({ name: "E2E", ensure: false }))
        .toMatchObject({ name: "E2E" })
      expect(yield* Schema.decodeUnknownEffect(create)({ name: "", ensure: false }))
        .toMatchObject({ name: "" })
      expect(yield* Schema.decodeUnknownEffect(create)({ name: "a".repeat(65), ensure: false }))
        .toMatchObject({ name: "a".repeat(65) })
    }))

  it.effect("ProjectCreate accepts an arbitrarily long directory string", () =>
    Effect.gen(function*() {
      const long = `/${"x".repeat(4096)}`
      expect(yield* Schema.decodeUnknownEffect(payloadOf("ProjectCreate"))({
        name: "ok",
        ensure: false,
        directory: long
      })).toMatchObject({ directory: long })
    }))

  it.effect("ProjectRename accepts a non-UUID id (existence is checked by the server)", () =>
    Schema.decodeUnknownEffect(payloadOf("ProjectRename"))({ id: "ghost", name: "ok" }).pipe(
      Effect.tap((payload) => Effect.sync(() => expect(payload).toMatchObject({ id: "ghost" })))
    ))
})
