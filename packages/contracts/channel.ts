export type Channel = "dev" | "release"

export const channel: Channel =
  typeof __EXPAND_CHANNEL__ !== "undefined" ? __EXPAND_CHANNEL__ : "dev"
