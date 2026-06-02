import { Box, Text } from "ink"
import type { Project } from "@yodea/contracts/project"

export const ProjectList = ({ projects, selectedId }: { projects: ReadonlyArray<Project>; selectedId?: string | undefined }) => (
  <Box flexDirection="column">
    <Text bold>Projects ({projects.length})</Text>
    {projects.length === 0 ? (
      <Text dimColor>no projects yet — type a name and press enter</Text>
    ) : (
      projects.map((p) => (
        <Text key={p.id} inverse={p.id === selectedId}>
          • {p.name} {p.archived ? <Text color="yellow">[archived]</Text> : null} <Text dimColor>{p.id}</Text>
        </Text>
      ))
    )}
  </Box>
)
