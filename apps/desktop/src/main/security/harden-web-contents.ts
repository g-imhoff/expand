// DI'd so it is electron-free and unit-testable. index.ts adapts the real
// BrowserWindow.webContents to these callbacks.
export interface HardenDeps {
  readonly onWillNavigate: (cb: (event: { preventDefault: () => void }, url: string) => void) => void
  readonly setWindowOpenHandler: (handler: (details: { url: string }) => { action: "deny" }) => void
  readonly isAllowed: (url: string) => boolean
}

// Block in-page navigation to anything but the renderer origin, and deny all
// window.open / target=_blank attempts. (Electron security checklist.)
export const hardenWebContents = ({ onWillNavigate, setWindowOpenHandler, isAllowed }: HardenDeps): void => {
  onWillNavigate((event, url) => {
    if (!isAllowed(url)) event.preventDefault()
  })
  setWindowOpenHandler(() => ({ action: "deny" }))
}
