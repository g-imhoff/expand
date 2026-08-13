import { Effect } from "effect"

export interface HardenDeps {
  readonly onWillNavigate: (
    listener: (event: { preventDefault: () => void }, url: string) => void
  ) => () => void
  readonly setWindowOpenHandler: (handler: (details: { url: string }) => { action: "deny" }) => void
  readonly isAllowed: (url: string) => boolean
}

export const hardenWebContents = Effect.fn("DesktopMain.hardenWebContents")(function* (
  deps: HardenDeps
) {
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      deps.onWillNavigate((event, url) => {
        if (!deps.isAllowed(url)) event.preventDefault()
      })
    ),
    (dispose) => Effect.sync(dispose)
  )
  yield* Effect.sync(() => deps.setWindowOpenHandler(() => ({ action: "deny" })))
})
