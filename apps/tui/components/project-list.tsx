import { Box, Text } from "ink"
import type { Project } from "@yodea/contracts/project"

export const ProjectList = ({ projects }: { projects: ReadonlyArray<Project> }) => (
  <Box flexDirection="column">
    <Text bold>Projects ({projects.length})</Text>
    {projects.length === 0 ? (
      <Text dimColor>no projects yet — type /new &lt;name&gt; to create one</Text>
    ) : (
      projects.map((p) => (
        <Text key={p.id}>
          • {p.name} <Text dimColor>{p.id}</Text>
        </Text>
      ))
    )}
  </Box>
)
