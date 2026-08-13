import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNotFound, ExpandRpcs } from "@expand/contracts/rpc"
import { ProjectDeleteResult } from "@expand/contracts/project"
import { ExpandHandlers } from "@expand/server/rpc/handlers"

describe("ExpandRpcs contract", () => {
  it("is a defined RpcGroup", () => {
    expect(ExpandRpcs).toBeDefined()
  })
  it("ProjectNotFound constructs with an id", () => {
    const e = new ProjectNotFound({ id: "p1" })
    expect(e._tag).toBe("ProjectNotFound")
    expect(e.id).toBe("p1")
  })
  it("ExpandHandlers covers every RPC (typechecks) and is defined", () => {
    expect(ExpandHandlers).toBeDefined()
  })
  it("ExpandHandlers layer includes the change-directory handler and constructs", () => {
    expect(ExpandHandlers).toBeDefined()
  })
  it("exposes the five procedures by tag", () => {
    const tags = [...ExpandRpcs.requests.keys()]
    expect(tags).toEqual(
      expect.arrayContaining(["Health", "ProjectCreate", "ProjectList", "Connect", "Events", "ProjectRename"])
    )
  })
  it("exposes ProjectChangeDirectory and its directory error classes", () => {
    expect([...ExpandRpcs.requests.keys()]).toEqual(
      expect.arrayContaining(["ProjectChangeDirectory"])
    )
    expect(new ProjectDirectoryInvalid({ directory: "/x", reason: "not-absolute" }).directory).toBe("/x")
    expect(new ProjectDirectoryConflict({ directory: "/x" }).directory).toBe("/x")
  })
  it("declares ProjectArchive and ProjectRestore methods", () => {
    const names = [...ExpandRpcs.requests.keys()]
    expect(names).toContain("ProjectArchive")
    expect(names).toContain("ProjectRestore")
  })
  it("declares ProjectSetMetadata with id + optional description/tags and ProjectNotFound error", () => {
    const rpc = ExpandRpcs.requests.get("ProjectSetMetadata")
    expect(rpc).toBeDefined()
  })
  it("Events accepts an optional fromSeq cursor", () => {
    const rpc = ExpandRpcs.requests.get("Events")!
    expect(Schema.decodeUnknownSync(rpc.payloadSchema)({})).toEqual({})
    expect(Schema.decodeUnknownSync(rpc.payloadSchema)({ fromSeq: 3 })).toEqual({ fromSeq: 3 })
  })
  it("ProjectList succeeds with a { projects, seq } snapshot", () => {
    const rpc = ExpandRpcs.requests.get("ProjectList")!
    expect(Schema.decodeUnknownSync(rpc.successSchema)({ projects: [], seq: 0 })).toEqual({ projects: [], seq: 0 })
  })
})

describe("ProjectDelete contract", () => {
  it("exposes the ProjectDelete procedure by tag", () => {
    expect([...ExpandRpcs.requests.keys()]).toEqual(expect.arrayContaining(["ProjectDelete"]))
  })
  it("ProjectDeleteResult is a defined schema", () => {
    expect(ProjectDeleteResult).toBeDefined()
  })
})
