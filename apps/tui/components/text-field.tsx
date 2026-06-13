// Render-only — receives state via props, registers NO input handler.
import React from "react"
import { Box, Text } from "ink"
import type { TextFieldState } from "@yodea/ink-input/text-field"

export const TextField = ({
  label, state, focused, color = "green"
}: {
  label: string
  state: TextFieldState
  focused: boolean
  color?: string
}) => (
  <Box>
    <Text color={color} dimColor={!focused}>{label}</Text>
    <Text dimColor={!focused}>{state.value}</Text>
    {focused ? <Text>▍</Text> : null}
  </Box>
)
