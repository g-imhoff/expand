import { Argument, Flag } from "effect/cli"
import { Effect, Option } from "effect"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import type { Project } from "@expand/contracts/project"
import { ProjectClient } from "@expand/client-ts/project"
import { defineCommand } from "@expand/cli/commands/define-command"
import { resolveProjectTarget } from "@expand/cli/commands/project/resolve-project-target"

export const setMetadataCommand = (() => {
  const target = Argument.String("project")
  const description = Flag.String("description").pipe(Flag.optional)
  // Raw strings: the backend validates tags at ingestion (ProjectInvalidInput).
  const tag = Flag.String("tag").pipe(Flag.atLeast(0))
  const clearTags = Flag.Boolean("clear-tags").pipe(Flag.withDefault(false))

  return defineCommand(
    "set-metadata",
    { project: target, description, tag, clearTags },
    {
      envelope: (p: Project) => makeEnvelope("Project", { created: false, data: p }),
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
})()
