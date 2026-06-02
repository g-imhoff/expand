import { Command } from "effect/unstable/cli"
import { createCommand } from "@yodea/cli/commands/project/create"
import { listCommand } from "@yodea/cli/commands/project/list"
import { renameCommand } from "@yodea/cli/commands/project/rename"
import { changeDirectoryCommand } from "@yodea/cli/commands/project/change-directory"

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects"),
  Command.withSubcommands([createCommand, listCommand, renameCommand, changeDirectoryCommand])
)
