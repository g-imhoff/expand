import { Box, Text, useInput, usePaste } from "ink"
import { useCommandBar } from "@yodea/tui/hooks/use-command-bar"
import { Suggestions } from "@yodea/tui/components/suggestions"

export interface ComposerProps {
  readonly isActive: boolean
  readonly onSubmit: (line: string) => void
}

export const Composer = ({ isActive, onSubmit }: ComposerProps) => {
  const [state, dispatch] = useCommandBar()

  usePaste((text) => dispatch({ type: "insert", text }), { isActive })

  useInput(
    (input, key) => {
      if (key.return) {
        if (key.shift) {
          dispatch({ type: "newline" })
          return
        }
        onSubmit(state.buffer)
        dispatch({ type: "commit" })
        return
      }
      if (key.upArrow) {
        dispatch({ type: "historyPrev" })
        return
      }
      if (key.downArrow) {
        dispatch({ type: "historyNext" })
        return
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "backspace" })
        return
      }
      if (key.escape) {
        dispatch({ type: "reset" })
        return
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "insert", text: input })
      }
    },
    { isActive }
  )

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">▸ </Text>
        {state.buffer.length === 0 ? (
          <Text dimColor>type a message, or /command (try /help)</Text>
        ) : (
          <Text>{state.buffer}</Text>
        )}
      </Box>
      <Suggestions commands={state.suggestions} />
    </Box>
  )
}
