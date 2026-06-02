import { Box, useInput } from "ink"
import { useState } from "react"
import { ProjectList } from "@yodea/tui/components/project-list"
import { CreateInput } from "@yodea/tui/components/create-input"
import { RenameInput } from "@yodea/tui/components/rename-input"
import { DirectoryInput } from "@yodea/tui/components/directory-input"
import { useProjects } from "@yodea/tui/use-projects"

export const App = () => {
  const { projects, create, rename, changeDirectory } = useProjects()
  const [mode, setMode] = useState<"list" | "rename" | "directory">("list")
  const selected = projects[0] ?? null
  useInput((input) => {
    if (mode === "list" && selected) {
      if (input === "r") setMode("rename")
      else if (input === "d") setMode("directory")
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      <ProjectList projects={projects} />
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
      ) : (
        <CreateInput onSubmit={create} />
      )}
    </Box>
  )
}
