export const libraryBoundaryFixtures = {
  electronIpc: {
    packagePath: "packages/electron-ipc/package.json",
    publicEntries: {
      contract: {
        specifier: "@expand/electron-ipc/contract",
        runtimeExports: ["IpcChannel", "IpcContract"]
      },
      main: {
        specifier: "@expand/electron-ipc/main",
        runtimeExports: ["bindElectronIpc"]
      },
      preload: {
        specifier: "@expand/electron-ipc/preload",
        runtimeExports: ["exposeElectronBridge"]
      },
      renderer: {
        specifier: "@expand/electron-ipc/renderer",
        runtimeExports: ["IpcTransportError", "makeElectronIpcClient"]
      }
    },
    exportMap: {
      "./contract": "./contract.ts",
      "./main": "./main.ts",
      "./preload": "./preload.ts",
      "./renderer": "./renderer.ts",
      "./package.json": "./package.json"
    }
  },
  inkInput: {
    packagePath: "packages/ink-input/package.json",
    publicEntries: {
      root: {
        specifier: "@expand/ink-input",
        runtimeExports: ["HintBar", "defineBindings", "useGlobalKeyRouter"]
      }
    },
    exportMap: {
      ".": "./index.ts",
      "./package.json": "./package.json"
    }
  }
} as const

export const privateLibraryPathAliases = ["@expand/electron-ipc", "@expand/ink-input"] as const
