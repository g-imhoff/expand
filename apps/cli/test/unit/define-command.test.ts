import { describe, expect, it } from "vitest"
import { Argument, Command, GlobalFlag } from "effect/unstable/cli"
import { Effect } from "effect"
import { defineCommand } from "@yodea/cli/_command"
import { Format, Quiet } from "@yodea/cli/global-flags"
import { ProjectClient } from "@yodea/client-core"
import { runCli, stubLayer } from "../harness"

const create = defineCommand(
  "make",
  { name: Argument.string("name") },
  {
    envelope: (r: { created: boolean; project: { id: string; name: string; createdAt: string } }) => ({
      apiVersion: "yodea/v1", kind: "Project", created: r.created, data: r.project
    }),
    text: (r) => `created ${r.project.id}  ${r.project.name}`,
    quiet: (r) => r.project.id
  },
  ({ name }): Effect.Effect<{ created: boolean; project: { id: string; name: string; createdAt: string } }, unknown, ProjectClient> =>
    Effect.flatMap(ProjectClient, (c) => c.create({ name: name as string, ensure: false }))
)

const tree = (stub: object) =>
  Command.make("t").pipe(
    Command.withSubcommands([create.pipe(Command.provide(stubLayer(stub)))]),
    Command.withGlobalFlags([Format, Quiet, ...GlobalFlag.BuiltIns])
  )

const okClient = { ProjectCreate: ({ name }: { name: string; ensure: boolean }) => Effect.succeed({ created: true, project: { id: "01J", name, createdAt: "t" } }) }
const conflictClient = { ProjectCreate: () => Effect.fail({ _tag: "ProjectAlreadyExists", name: "foo" }) }

describe("defineCommand seam", () => {
  it("emits a JSON envelope to stdout, exit 0, stderr empty", async () => {
    const r = await runCli(tree(okClient), ["make", "foo"])
    expect(r.code).toBe(0)
    expect(r.stderr).toEqual([])
    expect(JSON.parse(r.stdout.join(""))).toMatchObject({ apiVersion: "yodea/v1", kind: "Project", created: true, data: { name: "foo" } })
  })
  it("--quiet emits the bare id", async () => {
    const r = await runCli(tree(okClient), ["make", "foo", "--quiet"])
    expect(r.stdout.join("")).toBe("01J"); expect(r.code).toBe(0)
  })
  it("--format text emits a human line", async () => {
    const r = await runCli(tree(okClient), ["make", "foo", "--format", "text"])
    expect(r.stdout.join("")).toContain("created 01J  foo")
  })
  it("domain error -> stderr JSON, stdout empty, exit 5", async () => {
    const r = await runCli(tree(conflictClient), ["make", "foo"])
    expect(r.stdout).toEqual([])
    expect(JSON.parse(r.stderr.join(""))).toMatchObject({ kind: "Error", code: "PROJECT_EXISTS", retryable: false })
    expect(r.code).toBe(5)
  })
})
