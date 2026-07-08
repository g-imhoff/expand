import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ENVELOPE_VERSION, ErrorEnvelope, ProjectEnvelope, ProjectListEnvelope, HealthEnvelope } from "@expand/cli/contract/envelope"
import { ProjectCreateResult } from "@expand/contracts/project"

const dec = <A, I>(s: Schema.Codec<A, I>, u: unknown) => Schema.decodeUnknownSync(s)(u)

const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

describe("cli/contract/envelope", () => {
  it("ENVELOPE_VERSION is expand/v1", () => {
    expect(ENVELOPE_VERSION).toBe("expand/v1")
  })

  it("ProjectEnvelope round-trips a created project", () => {
    const v = { apiVersion: "expand/v1", kind: "Project", created: true, data: { id: uid(1), name: "foo", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } }
    expect(dec(ProjectEnvelope, v)).toEqual(v)
  })

  it("ProjectListEnvelope carries count + array", () => {
    const v = { apiVersion: "expand/v1", kind: "ProjectList", count: 1, data: [{ id: uid(1), name: "foo", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" }] }
    expect(dec(ProjectListEnvelope, v)).toEqual(v)
  })

  it("HealthEnvelope wraps a status", () => {
    const v = { apiVersion: "expand/v1", kind: "Health", data: { status: "ok" } }
    expect(dec(HealthEnvelope, v)).toEqual(v)
  })

  it("ErrorEnvelope validates a tagged error code", () => {
    const v = { apiVersion: "expand/v1", kind: "Error", code: "PROJECT_EXISTS", message: "x", retryable: false }
    expect(dec(ErrorEnvelope, v)).toEqual(v)
    expect(() => dec(ErrorEnvelope, { ...v, code: "NOPE" })).toThrow()
  })

  it("ProjectCreateResult pairs created + project", () => {
    const v = { created: false, project: { id: uid(1), name: "foo", directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } }
    expect(dec(ProjectCreateResult, v)).toEqual(v)
  })
})
