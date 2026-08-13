// Render-only.
import React from "react"
import { Box, Text } from "ink"
import type { Project } from "@expand/contracts/project"

export const ProjectList = ({
  projects, selectedId, focused
}: {
  projects: ReadonlyArray<Project>
  selectedId?: string | undefined
  focused: boolean
}) => (
  <Box flexDirection="column">
    <Text bold dimColor={!focused}>Projects ({projects.length})</Text>
    {projects.length === 0 ? (
      <Text dimColor>no projects yet — press n to create one</Text>
    ) : (
      projects.map((p) => (
        <Text key={p.id} inverse={focused && p.id === selectedId} dimColor={!focused}>
          {p.id === selectedId ? "▸" : "•"} {p.name} {p.archived ? <Text color="yellow">[archived]</Text> : null} <Text dimColor>{p.id}</Text>
        </Text>
      ))
    )}
  </Box>
)
