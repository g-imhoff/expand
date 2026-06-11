import { Box, useInput } from "ink"
import { useState } from "react"
import { ProjectList } from "@yodea/tui/components/project-list"
import { CreateInput } from "@yodea/tui/components/create-input"
import { RenameInput } from "@yodea/tui/components/rename-input"
import { DirectoryInput } from "@yodea/tui/components/directory-input"
import { MetadataInput } from "@yodea/tui/components/metadata-input"
import { ConfirmDelete } from "@yodea/tui/components/confirm-delete"
import { ErrorLine } from "@yodea/tui/components/error-line"
import { useProjects } from "@yodea/tui/use-projects"

export const App = () => {
  const { projects, error, create, rename, changeDirectory, archive, restore, setMetadata, deleteProject } = useProjects()
  const [mode, setMode] = useState<"list" | "rename" | "directory" | "metadata" | "confirmDelete">("list")
  const selected = projects[0] ?? null
  useInput((input, key) => {
    if (mode === "list" && selected) {
      if (input === "r") setMode("rename")
      else if (input === "d") setMode("directory")
      else if (input === "m") setMode("metadata")
      else if (input === "x" || key.delete) setMode("confirmDelete")
      else if (input === "a") {
        if (selected.archived) restore(selected.id)
        else archive(selected.id)
      }
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      <ProjectList projects={projects} selectedId={selected?.id} />
      <ErrorLine message={error} />
      {mode === "rename" && selected ? (
        <RenameInput
          current={selected.name}
          onSubmit={(name) => { rename(selected.id, name); setMode("list") }}
          onCancel={() => setMode("list")}
        />
      ) : mode === "directory" && selected ? (
        <DirectoryInput
          projectName={selected.name}
          onSubmit={(dir) => { changeDirectory(selected.id, dir); setMode("list") }}
          onCancel={() => setMode("list")}
        />
      ) : mode === "metadata" && selected ? (
        <MetadataInput
          onSubmit={(patch) => { setMetadata(selected.id, patch); setMode("list") }}
        />
      ) : mode === "confirmDelete" && selected ? (
        <ConfirmDelete
          projectName={selected.name}
          onConfirm={() => { deleteProject(selected.id); setMode("list") }}
          onCancel={() => setMode("list")}
        />
      ) : (
        <CreateInput onSubmit={create} />
      )}
    </Box>
  )
}
