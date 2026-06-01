import { Box, Text } from "ink"

export const ErrorView = ({ message }: { readonly message: string }) => (
  <Box flexDirection="column" borderStyle="round" paddingX={1}>
    <Text bold color="red">
      Something went wrong
    </Text>
    <Text>{message}</Text>
    <Text dimColor>Press Ctrl-C to exit.</Text>
  </Box>
)
