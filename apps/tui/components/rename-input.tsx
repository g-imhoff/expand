import { Box, Text, useInput } from "ink"
import { useState } from "react"

// Controlled rename input, seeded from `current`. Enter submits the trimmed value;
// Escape cancels. Mirrors CreateInput but prefilled.
export const RenameInput = ({
  current, onSubmit, onCancel
}: { current: string; onSubmit: (name: string) => void; onCancel: () => void }) => {
  const [value, setValue] = useState(current)
  useInput((input, key) => {
    if (key.return) {
      const name = value.trim()
      if (name) onSubmit(name)
    } else if (key.escape) {
      onCancel()
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
    } else if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input)
    }
  })
  return (
    <Box>
      <Text color="yellow">rename ▸ </Text>
      <Text>{value}</Text>
    </Box>
  )
}
