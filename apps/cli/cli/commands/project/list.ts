import { Flag } from "effect/unstable/cli"
import { Effect } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/version"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"

export const listCommand = (() => {
  const sorted = (ps: ReadonlyArray<Project>) =>
    [...ps].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)))

  const archived = Flag.boolean("archived").pipe(Flag.withDefault(false))
  const all = Flag.boolean("all").pipe(Flag.withDefault(false))

  return defineCommand(
    "list",
    { archived, all },
    {
      envelope: (ps: ReadonlyArray<Project>) => ({ apiVersion: ENVELOPE_VERSION, kind: "ProjectList", count: ps.length, data: sorted(ps) }),
      text: (ps: ReadonlyArray<Project>) => sorted(ps).map((p) => `${p.id}  ${p.name}`).join("\n"),
      quiet: (ps: ReadonlyArray<Project>) => sorted(ps).map((p) => p.id).join("\n")
    },
    ({ archived, all }): Effect.Effect<ReadonlyArray<Project>, unknown, ProjectClient> =>
      Effect.map(
        Effect.flatMap(ProjectClient, (c) => c.list({ includeArchived: archived || all })),
        (r) => r.projects
      )
  )
})()
