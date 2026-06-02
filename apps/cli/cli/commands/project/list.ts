import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import type { Project } from "@yodea/contracts/project"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"

// Stable order so an agent can diff list output across calls: (createdAt, id).
const sorted = (ps: ReadonlyArray<Project>) =>
  [...ps].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)))

export const listCommand = defineCommand(
  "list",
  {},
  {
    envelope: (ps: ReadonlyArray<Project>) => ({ apiVersion: API_VERSION, kind: "ProjectList", count: ps.length, data: sorted(ps) }),
    text: (ps: ReadonlyArray<Project>) => sorted(ps).map((p) => `${p.id}  ${p.name}`).join("\n"),
    quiet: (ps: ReadonlyArray<Project>) => sorted(ps).map((p) => p.id).join("\n")
  },
  (): Effect.Effect<ReadonlyArray<Project>, unknown, YodeaClient> => Effect.flatMap(YodeaClient, (c) => c.ProjectList())
)
