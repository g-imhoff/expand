export type Channel = "dev" | "release"

export const channel: Channel =
  typeof __YODEA_CHANNEL__ !== "undefined" ? __YODEA_CHANNEL__ : "dev"
