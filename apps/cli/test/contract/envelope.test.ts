import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { describe, expect } from "vitest"
import { ENVELOPE_VERSION } from "@expand/cli/contract/version"
import { ErrorEnvelope } from "@expand/cli/errors/envelope"
import { ProjectEnvelope, ProjectListEnvelope } from "@expand/cli/contract/project/envelope"
import { HealthEnvelope } from "@expand/cli/contract/server/envelope"
import { ProjectCreateResult } from "@expand/contracts/project"

const uid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

describe("cli/contract/envelope", () => {
  it("ENVELOPE_VERSION is expand/v1", () => {
    expect(ENVELOPE_VERSION).toBe("expand/v1")
  })

  it.effect("ProjectEnvelope round-trips a created project", () => {
    const value = {
      apiVersion: "expand/v1",
      kind: "Project",
      created: true,
      data: {
        id: uid(1),
        name: "foo",
        directory: null,
        description: null,
        tags: [],
        archived: false,
        createdAt: "t",
        updatedAt: "t"
      }
    }
    return Schema.decodeUnknownEffect(ProjectEnvelope)(value).pipe(
      Effect.tap((decoded) => Effect.sync(() => expect(decoded).toEqual(value)))
    )
  })

  it.effect("ProjectListEnvelope carries count + array", () => {
    const value = {
      apiVersion: "expand/v1",
      kind: "ProjectList",
      count: 1,
      data: [{
        id: uid(1),
        name: "foo",
        directory: null,
        description: null,
        tags: [],
        archived: false,
        createdAt: "t",
        updatedAt: "t"
      }]
    }
    return Schema.decodeUnknownEffect(ProjectListEnvelope)(value).pipe(
      Effect.tap((decoded) => Effect.sync(() => expect(decoded).toEqual(value)))
    )
  })

  it.effect("HealthEnvelope wraps a status", () => {
    const value = { apiVersion: "expand/v1", kind: "ServerHealth", data: { status: "ok" } }
    return Schema.decodeUnknownEffect(HealthEnvelope)(value).pipe(
      Effect.tap((decoded) => Effect.sync(() => expect(decoded).toEqual(value)))
    )
  })

  it.effect("ErrorEnvelope validates a tagged error code", () =>
    Effect.gen(function*() {
      const value = {
        apiVersion: "expand/v1",
        kind: "Error",
        code: "PROJECT_EXISTS",
        message: "x",
        retryable: false
      }
      expect(yield* Schema.decodeUnknownEffect(ErrorEnvelope)(value)).toEqual(value)
      expect(Result.isFailure(
        yield* Schema.decodeUnknownEffect(ErrorEnvelope)({ ...value, code: "NOPE" }).pipe(Effect.result)
      )).toBe(true)
    }))

  it.effect("ProjectCreateResult pairs created + project", () => {
    const value = {
      created: false,
      project: {
        id: uid(1),
        name: "foo",
        directory: null,
        description: null,
        tags: [],
        archived: false,
        createdAt: "t",
        updatedAt: "t"
      }
    }
    return Schema.decodeUnknownEffect(ProjectCreateResult)(value).pipe(
      Effect.tap((decoded) => Effect.sync(() => expect(decoded).toEqual(value)))
    )
  })
})
