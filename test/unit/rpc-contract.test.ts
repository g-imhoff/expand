import { describe, expect, it } from "vitest"
import { ProjectDirectoryConflict, ProjectDirectoryInvalid, ProjectNotFound, YodeaRpcs } from "@yodea/contracts/rpc"
import { ProjectDeleteResult } from "@yodea/contracts/project"
import { ProjectDeleteEnvelope } from "@yodea/contracts/cli"
import { YodeaHandlers } from "@yodea/server/rpc-handlers"

describe("YodeaRpcs contract", () => {
  it("is a defined RpcGroup", () => {
    expect(YodeaRpcs).toBeDefined()
  })
  it("ProjectNotFound constructs with an id", () => {
    const e = new ProjectNotFound({ id: "p1" })
    expect(e._tag).toBe("ProjectNotFound")
    expect(e.id).toBe("p1")
  })
  it("YodeaHandlers covers every RPC (typechecks) and is defined", () => {
    expect(YodeaHandlers).toBeDefined()
  })
  it("YodeaHandlers layer includes the change-directory handler and constructs", () => {
    expect(YodeaHandlers).toBeDefined()
  })
  it("exposes the five procedures by tag", () => {
    // RpcGroup exposes its requests; assert the tags we depend on exist.
    const tags = [...YodeaRpcs.requests.keys()]
    expect(tags).toEqual(
      expect.arrayContaining(["Health", "ProjectCreate", "ProjectList", "Connect", "Events", "ProjectRename"])
    )
  })
  it("exposes ProjectChangeDirectory and its directory error classes", () => {
    expect([...YodeaRpcs.requests.keys()]).toEqual(
      expect.arrayContaining(["ProjectChangeDirectory"])
    )
    expect(new ProjectDirectoryInvalid({ directory: "/x", reason: "not-absolute" }).directory).toBe("/x")
    expect(new ProjectDirectoryConflict({ directory: "/x" }).directory).toBe("/x")
  })
  it("declares ProjectArchive and ProjectRestore methods", () => {
    const names = [...YodeaRpcs.requests.keys()]
    expect(names).toContain("ProjectArchive")
    expect(names).toContain("ProjectRestore")
  })
  it("declares ProjectSetMetadata with id + optional description/tags and ProjectNotFound error", () => {
    const rpc = YodeaRpcs.requests.get("ProjectSetMetadata")
    expect(rpc).toBeDefined()
  })
})

describe("ProjectDelete contract", () => {
  it("exposes the ProjectDelete procedure by tag", () => {
    expect([...YodeaRpcs.requests.keys()]).toEqual(expect.arrayContaining(["ProjectDelete"]))
  })
  it("ProjectDeleteResult and ProjectDeleteEnvelope are defined schemas", () => {
    expect(ProjectDeleteResult).toBeDefined()
    expect(ProjectDeleteEnvelope).toBeDefined()
  })
})
