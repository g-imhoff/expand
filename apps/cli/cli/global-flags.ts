import { Flag, GlobalFlag } from "effect/unstable/cli"

export const DataDir = GlobalFlag.setting("data-dir")({
  flag: Flag.directory("data-dir", { mustExist: false }).pipe(
    Flag.optional,
    Flag.withDescription("override Expand's state directory")
  )
})

export const Format = GlobalFlag.setting("format")({
  flag: Flag.choice("format", ["json", "text"]).pipe(Flag.withDefault("json"))
})

export const Quiet = GlobalFlag.setting("quiet")({
  flag: Flag.boolean("quiet").pipe(Flag.withAlias("q"), Flag.withDefault(false))
})
