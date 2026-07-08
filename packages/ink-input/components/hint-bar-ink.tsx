// packages/ink-input/components/hint-bar-ink.tsx
// Ink adapter — renders any binding table as a hint line. Render-only.
import React from "react"
import { Box, Text } from "ink"
import type { Binding } from "@expand/ink-input/bindings"

export const HintBar = <A,>({ bindings }: { bindings: ReadonlyArray<Binding<A>> }) => (
  <Box>
    <Text dimColor>
      {bindings.map((b) => `${b.keys[0]} ${b.label}`).join(" · ")}
    </Text>
  </Box>
)
