import { Flag } from "effect/unstable/cli"
import { Effect } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import type { Project } from "@yodea/contracts/project"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"

// Stable order so an agent can diff list output across calls: (createdAt, id).
const sorted = (ps: ReadonlyArray<Project>) =>
  [...ps].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)))

// `--archived`/`--all` both include archived projects (kept live: name/directory
// reserved). Default (neither) hides them, matching the backend's read filter.
const archived = Flag.boolean("archived").pipe(Flag.withDefault(false))
const all = Flag.boolean("all").pipe(Flag.withDefault(false))

export const listCommand = defineCommand(
  "list",
  { archived, all },
  {
    envelope: (ps: ReadonlyArray<Project>) => ({ apiVersion: API_VERSION, kind: "ProjectList", count: ps.length, data: sorted(ps) }),
    text: (ps: ReadonlyArray<Project>) => sorted(ps).map((p) => `${p.id}  ${p.name}`).join("\n"),
    quiet: (ps: ReadonlyArray<Project>) => sorted(ps).map((p) => p.id).join("\n")
  },
  ({ archived, all }): Effect.Effect<ReadonlyArray<Project>, unknown, YodeaClient> =>
    Effect.flatMap(YodeaClient, (c) => c.ProjectList({ includeArchived: archived || all }))
)
