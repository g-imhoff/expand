import { Argument, Flag } from "effect/unstable/cli"
import { Effect, Option } from "effect"
import { ENVELOPE_VERSION } from "@expand/cli/contract/envelope"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-core"
import { defineCommand } from "@expand/cli/_command"
import { resolveProjectTarget } from "@expand/cli/commands/project/_resolve"

const target = Argument.string("project")
const description = Flag.string("description").pipe(Flag.optional)
// Raw strings: the backend validates tags at ingestion (ProjectInvalidInput).
const tag = Flag.string("tag").pipe(Flag.atLeast(0))
const clearTags = Flag.boolean("clear-tags").pipe(Flag.withDefault(false))

export const setMetadataCommand = defineCommand(
  "set-metadata",
  { project: target, description, tag, clearTags },
  {
    envelope: (p: Project) => ({ apiVersion: ENVELOPE_VERSION, kind: "Project", created: false, data: p }),
    text: (p: Project) => `${p.id}  ${p.name}`,
    quiet: (p: Project) => p.id
  },
  ({ project, description, tag, clearTags }): Effect.Effect<Project, unknown, ProjectClient> =>
    Effect.gen(function* () {
      const c = yield* ProjectClient
      const id = yield* resolveProjectTarget(project)
      const tags = clearTags ? [] : tag.length > 0 ? tag : undefined
      return yield* c.setMetadata({
        id,
        ...(Option.isSome(description) ? { description: description.value } : {}),
        ...(tags !== undefined ? { tags } : {})
      })
    })
)
