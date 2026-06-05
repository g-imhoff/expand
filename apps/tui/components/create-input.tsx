import { Box, Text, useInput } from "ink"
import { useState } from "react"

export const CreateInput = ({ onSubmit }: { onSubmit: (name: string) => void }) => {
  const [value, setValue] = useState("")
  useInput((input, key) => {
    if (key.return) {
      const name = value.trim()
      if (name) {
        onSubmit(name)
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
      <Text color="green">new project ▸ </Text>
      <Text>{value}</Text>
    </Box>
  )
}
