import { Text } from "ink"

export const ErrorLine = ({ message }: { message: string | null }) =>
  message === null ? null : <Text color="red">{message}</Text>
