import { Box, useInput } from "ink"
import { useState } from "react"
import { ProjectList } from "@yodea/tui/components/project-list"
import { CreateInput } from "@yodea/tui/components/create-input"
import { RenameInput } from "@yodea/tui/components/rename-input"
import { useProjects } from "@yodea/tui/use-projects"

export const App = () => {
  const { projects, create, rename } = useProjects()
  const [mode, setMode] = useState<"list" | "rename">("list")
  const selected = projects[0] ?? null
  useInput((input) => {
    if (mode === "list" && input === "r" && selected) setMode("rename")
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
      ) : (
        <CreateInput onSubmit={create} />
      )}
    </Box>
  )
}
