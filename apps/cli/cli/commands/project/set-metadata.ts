import { Argument, Flag } from "effect/unstable/cli"
import { Effect, Option } from "effect"
import { API_VERSION } from "@yodea/contracts/cli"
import type { Project } from "@yodea/contracts/project"
import { YodeaClient } from "@yodea/client-core"
import { defineCommand } from "@yodea/cli/_command"
import { resolveProjectTarget } from "@yodea/cli/commands/project/_resolve"

const target = Argument.string("project")
const description = Flag.string("description").pipe(Flag.optional)
const tag = Flag.string("tag").pipe(Flag.atLeast(0))
const clearTags = Flag.boolean("clear-tags").pipe(Flag.withDefault(false))

export const setMetadataCommand = defineCommand(
  "set-metadata",
  { project: target, description, tag, clearTags },
  {
    envelope: (p: Project) => ({ apiVersion: API_VERSION, kind: "Project", created: false, data: p }),
    text: (p: Project) => `${p.id}  ${p.name}`,
    quiet: (p: Project) => p.id
  },
  ({ project, description, tag, clearTags }): Effect.Effect<Project, unknown, YodeaClient> =>
    Effect.gen(function* () {
      const c = yield* YodeaClient
      const id = yield* resolveProjectTarget(project)
      const tags = clearTags ? [] : tag.length > 0 ? tag : undefined
      return yield* c.ProjectSetMetadata({
        id,
        ...(Option.isSome(description) ? { description: description.value } : {}),
        ...(tags !== undefined ? { tags } : {})
      })
    })
)
