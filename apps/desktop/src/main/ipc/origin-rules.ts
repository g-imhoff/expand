import type { OriginRule } from "@expand/electron-ipc/main"

export const originRulesFor = (
  packagedRendererUrl: string,
  devUrl: string | undefined
): ReadonlyArray<OriginRule> =>
  devUrl === undefined
    ? [{ _tag: "exactUrl", url: packagedRendererUrl }]
    : [{ _tag: "exactOrigin", origin: new URL(devUrl).origin }]
