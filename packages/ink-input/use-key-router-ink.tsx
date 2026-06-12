// ============================================================================
// THE one ink useInput in the entire repository (pinned by
// test/architecture/tui-input-boundary.test.ts). Raw useInput is a global
// broadcast — every mounted handler receives every key — so exclusivity is
// only possible if exactly one handler exists. All routing decisions belong
// in the consumer's pure route function, never here.
// ============================================================================
import { useInput } from "ink"
import { toKeyName, type KeyName } from "@yodea/ink-input/key-name"

export const useKeyRouter = (
  onKey: (keyName: KeyName, input: string) => void
): void => {
  useInput((input, key) => {
    onKey(toKeyName(input, key), input)
  })
}
