import { Box, Text, useInput } from "ink"
import { useState } from "react"

// A tiny controlled input mirroring CreateInput. The TUI v1 metadata surface
// edits the description only; it submits a `{ description }` patch.
export const MetadataInput = ({ onSubmit }: { onSubmit: (patch: { description: string }) => void }) => {
  const [value, setValue] = useState("")
  useInput((input, key) => {
    if (key.return) {
      const description = value.trim()
      if (description) {
        onSubmit({ description })
        setValue("")
      }
    } else if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
    } else if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input)
    }
  })
  return (
    <Box>
      <Text color="cyan">description ▸ </Text>
      <Text>{value}</Text>
    </Box>
  )
}
