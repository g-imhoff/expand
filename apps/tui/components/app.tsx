import { Box } from "ink"
import { ProjectList } from "@yodea/tui/components/project-list"
import { CreateInput } from "@yodea/tui/components/create-input"
import { useProjects } from "@yodea/tui/use-projects"

export const App = () => {
  const { projects, create } = useProjects()
  return (
    <Box flexDirection="column" gap={1}>
      <ProjectList projects={projects} />
      <CreateInput onSubmit={create} />
    </Box>
  )
}
