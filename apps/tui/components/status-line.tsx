import { Box, Text } from "ink"
import type { Screen } from "@yodea/tui/app-state"

export interface StatusLineProps {
  readonly screen: Screen
  readonly projectName?: string | undefined
  readonly transientError?: string | undefined
  readonly notice?: string | undefined
}

export const StatusLine = ({ screen, projectName, transientError, notice }: StatusLineProps) => (
  <Box flexDirection="column">
    <Text dimColor>
      {screen.kind === "projectWorkspace"
        ? `project: ${projectName ?? screen.projectId}`
        : "Yodea — projects"}
    </Text>
    {transientError ? <Text color="red">⚠ {transientError}</Text> : null}
    {notice && !transientError ? <Text dimColor>{notice}</Text> : null}
  </Box>
)
