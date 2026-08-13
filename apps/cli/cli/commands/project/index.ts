import { Command } from "effect/unstable/cli"
import { createCommand } from "@expand/cli/commands/project/create"
import { listCommand } from "@expand/cli/commands/project/list"
import { renameCommand } from "@expand/cli/commands/project/rename"
import { changeDirectoryCommand } from "@expand/cli/commands/project/change-directory"
import { archiveCommand } from "@expand/cli/commands/project/archive"
import { restoreCommand } from "@expand/cli/commands/project/restore"
import { setMetadataCommand } from "@expand/cli/commands/project/set-metadata"
import { deleteCommand } from "@expand/cli/commands/project/delete"

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects"),
  Command.withSubcommands([createCommand, listCommand, renameCommand, changeDirectoryCommand, archiveCommand, restoreCommand, setMetadataCommand, deleteCommand])
)
