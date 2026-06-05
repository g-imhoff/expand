export interface HardenDeps {
  readonly onWillNavigate: (cb: (event: { preventDefault: () => void }, url: string) => void) => void
  readonly setWindowOpenHandler: (handler: (details: { url: string }) => { action: "deny" }) => void
  readonly isAllowed: (url: string) => boolean
}

export const hardenWebContents = ({ onWillNavigate, setWindowOpenHandler, isAllowed }: HardenDeps): void => {
  onWillNavigate((event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  setWindowOpenHandler(() => ({ action: "deny" }))
}
