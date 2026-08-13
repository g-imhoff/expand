// Render-only — y/n handling lives in the router (confirmDeleteBindings).
import React from "react"
import { Box, Text } from "ink"

export const ConfirmDelete = ({ projectName }: { projectName: string }) => (
  <Box>
    <Text color="red">delete “{projectName}”? </Text>
    <Text dimColor>(y/n)</Text>
  </Box>
)
