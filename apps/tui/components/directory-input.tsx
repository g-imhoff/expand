import { Box, Text, useInput } from "ink"
import { useState } from "react"

// Controlled directory input. Enter submits the trimmed path; Escape cancels.
// Mirrors CreateInput/RenameInput, prefixed with the project name in the prompt.
export const DirectoryInput = ({
  projectName, onSubmit, onCancel
}: { projectName: string; onSubmit: (dir: string) => void; onCancel: () => void }) => {
  const [value, setValue] = useState("")
  useInput((input, key) => {
    if (key.return) {
      const dir = value.trim()
      if (dir) { onSubmit(dir); setValue("") }
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
      <Text color="cyan">directory for {projectName} ▸ </Text>
      <Text>{value}</Text>
    </Box>
  )
}
