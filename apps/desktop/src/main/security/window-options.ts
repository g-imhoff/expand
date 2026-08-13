// Pure window-config module so architecture tests can pin webPreferences
// (ElectroVolt: published Electron RCE chains start at unsandboxed renderers).
export const windowOptions = (preloadPath: string) => ({
  width: 980,
  height: 700,
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true as const,
    nodeIntegration: false as const,
    sandbox: true as const
  }
})
