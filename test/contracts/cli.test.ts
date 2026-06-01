import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { API_VERSION, ErrorEnvelope, ProjectEnvelope, ProjectListEnvelope, HealthEnvelope } from "@yodea/contracts/cli"
import { ProjectName, ProjectCreateResult } from "@yodea/contracts/project"

const dec = <A, I>(s: Schema.Codec<A, I>, u: unknown) => Schema.decodeUnknownSync(s)(u)

describe("contracts/cli", () => {
  it("API_VERSION is yodea/v1", () => {
    expect(API_VERSION).toBe("yodea/v1")
  })

  it("ProjectEnvelope round-trips a created project", () => {
    const v = { apiVersion: "yodea/v1", kind: "Project", created: true, data: { id: "01J", name: "foo", createdAt: "t" } }
    expect(dec(ProjectEnvelope, v)).toEqual(v)
  })

  it("ProjectListEnvelope carries count + array", () => {
    const v = { apiVersion: "yodea/v1", kind: "ProjectList", count: 1, data: [{ id: "01J", name: "foo", createdAt: "t" }] }
    expect(dec(ProjectListEnvelope, v)).toEqual(v)
  })

  it("HealthEnvelope wraps a status", () => {
    const v = { apiVersion: "yodea/v1", kind: "Health", data: { status: "ok" } }
    expect(dec(HealthEnvelope, v)).toEqual(v)
  })

  it("ErrorEnvelope validates a tagged error code", () => {
    const v = { apiVersion: "yodea/v1", kind: "Error", code: "PROJECT_EXISTS", message: "x", retryable: false }
    expect(dec(ErrorEnvelope, v)).toEqual(v)
    expect(() => dec(ErrorEnvelope, { ...v, code: "NOPE" })).toThrow()
  })

  it("ProjectName accepts kebab names and rejects spaces/caps", () => {
    expect(dec(ProjectName, "my-proj-1")).toBe("my-proj-1")
    expect(() => dec(ProjectName, "My Proj")).toThrow()
    expect(() => dec(ProjectName, "")).toThrow()
  })

  it("ProjectCreateResult pairs created + project", () => {
    const v = { created: false, project: { id: "01J", name: "foo", createdAt: "t" } }
    expect(dec(ProjectCreateResult, v)).toEqual(v)
  })
})
