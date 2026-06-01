import { Box, Text } from "ink"
import type { SlashCommand } from "@yodea/tui/commands/types"

export const Suggestions = ({ commands }: { readonly commands: ReadonlyArray<SlashCommand> }) => {
  if (commands.length === 0) return null
  return (
    <Box flexDirection="column">
      {commands.map((c) => (
        <Text key={c.id} dimColor>
          /{c.name} — {c.description}
        </Text>
      ))}
    </Box>
  )
}
