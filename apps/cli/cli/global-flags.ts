import { Flag, GlobalFlag } from "effect/unstable/cli"

// Global output controls — declared once on the root, readable in every handler
// via `yield* Format` / `yield* Quiet`.
export const Format = GlobalFlag.setting("format")({
  flag: Flag.choice("format", ["json", "text"]).pipe(Flag.withDefault("json"))
})

export const Quiet = GlobalFlag.setting("quiet")({
  flag: Flag.boolean("quiet").pipe(Flag.withAlias("q"), Flag.withDefault(false))
})
