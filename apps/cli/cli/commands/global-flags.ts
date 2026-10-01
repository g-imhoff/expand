import { Flag, GlobalFlag } from "effect/cli"

export const DataDir = GlobalFlag.Setting("data-dir")({
  flag: Flag.Directory("data-dir", { mustExist: false }).pipe(
    Flag.optional,
    Flag.withDescription("override Expand's state directory")
  )
})

export const Format = GlobalFlag.Setting("format")({
  flag: Flag.Literals("format", ["json", "text"]).pipe(Flag.withDefault("json"))
})

export const Quiet = GlobalFlag.Setting("quiet")({
  flag: Flag.Boolean("quiet").pipe(Flag.withAlias("q"), Flag.withDefault(false))
})
