import { Box, Text, useInput } from "ink"

// A y/n confirmation prompt. The mode state-machine in app.tsx mounts this when a
// delete is requested (key 'x'/Delete) and unmounts it on confirm/cancel so exactly
// one useInput is active at a time. Escape cancels.
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
