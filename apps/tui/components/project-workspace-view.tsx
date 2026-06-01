import { Box, Text } from "ink"
import type { Project } from "@yodea/contracts/project"

export interface ProjectWorkspaceViewProps {
  readonly project?: Project | undefined
}

export const ProjectWorkspaceView = ({ project }: ProjectWorkspaceViewProps) => (
  <Box flexDirection="column" gap={1}>
    <Text bold>{project ? project.name : "Unknown project"}</Text>
    {/* ── CHAT SEAM ─────────────────────────────────────────────────────────
        The conversation transcript (Ink <Static> committed messages + one live
        streaming line) and a future <Transcript> component mount HERE. v1 only
        shows a placeholder. ─────────────────────────────────────────────── */}
    <Box borderStyle="round" paddingX={1}>
      <Text dimColor>💬 Conversations are coming soon. Type /projects to go back.</Text>
    </Box>
  </Box>
)
