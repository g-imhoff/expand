import { Box, Text, useInput } from "ink"

export const ConfirmDelete = ({
  projectName,
  onConfirm,
  onCancel
}: {
  projectName: string
  onConfirm: () => void
  onCancel: () => void
}) => {
  useInput((input, key) => {
    if (input === "y" || input === "Y") onConfirm()
    else if (input === "n" || input === "N" || key.escape) onCancel()
  })
  return (
    <Box>
      <Text color="red">delete “{projectName}”? </Text>
      <Text dimColor>(y/n)</Text>
    </Box>
  )
}
