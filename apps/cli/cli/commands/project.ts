import { Command } from "effect/unstable/cli"
import { createCommand } from "@yodea/cli/commands/project/create"
import { listCommand } from "@yodea/cli/commands/project/list"
import { renameCommand } from "@yodea/cli/commands/project/rename"
import { changeDirectoryCommand } from "@yodea/cli/commands/project/change-directory"
import { archiveCommand } from "@yodea/cli/commands/project/archive"
import { restoreCommand } from "@yodea/cli/commands/project/restore"
import { setMetadataCommand } from "@yodea/cli/commands/project/set-metadata"
import { deleteCommand } from "@yodea/cli/commands/project/delete"

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects"),
  Command.withSubcommands([createCommand, listCommand, renameCommand, changeDirectoryCommand, archiveCommand, restoreCommand, setMetadataCommand, deleteCommand])
)
