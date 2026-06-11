import type { OriginRule } from "@yodea/electron-ipc/main"

/** Production sender allowlist. Pinned by test: file protocol ONLY — never add dev origins here. */
export const prodOriginRules: ReadonlyArray<OriginRule> = [{ _tag: "fileProtocol" }]

export const originRulesFor = (devUrl: string | undefined): ReadonlyArray<OriginRule> =>
  devUrl === undefined ? prodOriginRules : [...prodOriginRules, { _tag: "exactOrigin", origin: new URL(devUrl).origin }]
