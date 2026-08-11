const nodeCryptoImport = "platform:import:node:crypto"
const nodeHttpImport = "platform:import:node:http"
const nodeOsImport = "platform:import:node:os"
const nodePathImport = "platform:import:node:path"
const nodeUrlImport = "platform:import:node:url"
const processCwd = "platform:process.cwd"
const processExecPath = "platform:process.execPath"
const processArgv = "platform:process.argv"
const processKill = "platform:process.kill"
const processMemoryUsage = "platform:process.memoryUsage"
const processPid = "platform:process.pid"
const processPlatform = "platform:process.platform"
const processVersion = "platform:process.version"
const processUmask = "platform:process.umask"
const desktopNodeRuntimeRunMain = "runner:NodeRuntime.runMain"
const testFixtureNodeRuntimeRunMain = "runner:NodeRuntime.runMain"
const scriptNodeRuntimeRunMain = "runner:NodeRuntime.runMain"
const documentGetElementById = "platform:document.getElementById"
const effectRunFork = "runner:Effect.runFork"
const effectRunPromise = "runner:Effect.runPromise"
const listenerAddEventListener = "platform:listener.addEventListener"
const listenerRemoveEventListener = "platform:listener.removeEventListener"
const windowExpand = "platform:window.expand"
const windowLocation = "platform:window.location"
const windowPostMessage = "platform:window.postMessage"

export const effectHostBoundaries = Object.freeze([
  Object.freeze({
    file: "apps/cli/cli/main.ts",
    declaration: "member:backendCommand.binaryArgs",
    host: "Node backend executable acquisition",
    construct: processExecPath,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/cli/cli/main.ts",
    declaration: "member:backendCommand.execPath",
    host: "Node backend executable acquisition",
    construct: processExecPath,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/cli/cli/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/cli/cli/runtime/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/cli/cli/runtime/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/electron.vite.config.ts",
    declaration: "module:<module>",
    host: "Electron Vite Node builtin catalog",
    construct: "platform:import:node:module",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/electron.vite.config.ts",
    declaration: "module:<module>",
    host: "Electron Vite repository path resolution",
    construct: "platform:import:node:path",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/electron.vite.config.ts",
    declaration: "module:<module>",
    host: "Electron Vite transported build identity",
    construct: "platform:process.env",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/e2e/effect-test.ts",
    declaration: "variable:makeTestEffect",
    host: "Playwright Effect test callback ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/e2e/effect-test.ts",
    declaration: "variable:makeTestEffect",
    host: "Playwright Effect test runtime",
    construct: effectRunPromise,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "module:<module>",
    host: "Electron main host adapter",
    construct: "platform:import:electron",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "module:<module>",
    host: "Electron main host adapter types",
    construct: "platform:import:electron",
    occurrence: 1
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.isPackaged",
    host: "Electron application state",
    construct: "platform:electron.app.isPackaged",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.ready",
    host: "Electron application readiness",
    construct: "platform:electron.app.whenReady",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.appendSwitch",
    host: "Electron command-line configuration",
    construct: "platform:electron.app.commandLine.appendSwitch",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.disableHardwareAcceleration",
    host: "Electron hardware acceleration configuration",
    construct: "platform:electron.app.disableHardwareAcceleration",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.onBeforeQuit",
    host: "Electron before-quit listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.onBeforeQuit",
    host: "Electron before-quit listener disposal",
    construct: "platform:listener.off",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.onWindowAllClosed",
    host: "Electron window-all-closed listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.onWindowAllClosed",
    host: "Electron window-all-closed listener disposal",
    construct: "platform:listener.off",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:appHost.quit",
    host: "Electron application shutdown",
    construct: "platform:electron.app.quit",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:csp.onHeadersReceived",
    host: "Electron response-header listener",
    construct: "platform:electron.session.defaultSession.webRequest.onHeadersReceived",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:csp.onHeadersReceived",
    host: "Electron response-header listener disposal",
    construct: "platform:electron.session.defaultSession.webRequest.onHeadersReceived",
    occurrence: 1
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "variable:browserWindow",
    host: "Electron browser-window construction",
    construct: "platform:electron.BrowserWindow",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:createWindow.onClosed",
    host: "Electron window-closed listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:createWindow.onClosed",
    host: "Electron window-closed listener disposal",
    construct: "platform:listener.off",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:createWindow.onNavigation",
    host: "Electron navigation listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:createWindow.onNavigation",
    host: "Electron navigation listener disposal",
    construct: "platform:listener.off",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:createWindow.onWillNavigate",
    host: "Electron will-navigate listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:createWindow.onWillNavigate",
    host: "Electron will-navigate listener disposal",
    construct: "platform:listener.off",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:deps.platform",
    host: "Electron platform selection",
    construct: processPlatform,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "member:deps.makeMessageChannel",
    host: "Electron message-channel construction",
    construct: "platform:electron.MessageChannelMain",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/index.ts",
    declaration: "module:<module>",
    host: "Electron application entrypoint",
    construct: desktopNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/runtime/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/main/runtime/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/app/runner.ts",
    declaration: "variable:fiber",
    host: "Renderer root Effect launcher",
    construct: effectRunFork,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/main.tsx",
    declaration: "variable:root",
    host: "Renderer React root host adapter",
    construct: documentGetElementById,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/main.tsx",
    declaration: "variable:getBridge",
    host: "Renderer preload bridge host adapter",
    construct: windowExpand,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/main.tsx",
    declaration: "variable:retry",
    host: "Renderer reload host adapter",
    construct: windowLocation,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/main.tsx",
    declaration: "variable:onDispose",
    host: "Renderer unload listener",
    construct: listenerAddEventListener,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/main.tsx",
    declaration: "variable:release",
    host: "Renderer unload listener disposal",
    construct: listenerRemoveEventListener,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/features/command/model/use-command-palette-hotkey.ts",
    declaration: "variable:useCommandPaletteHotkey",
    host: "Renderer command-palette keyboard listener",
    construct: listenerAddEventListener,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/desktop/src/renderer/features/command/model/use-command-palette-hotkey.ts",
    declaration: "variable:useCommandPaletteHotkey",
    host: "Renderer command-palette keyboard listener disposal",
    construct: listenerRemoveEventListener,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/transport/http-server.ts",
    declaration: "module:<module>",
    host: "Node HTTP adapter",
    construct: nodeCryptoImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/transport/http-server.ts",
    declaration: "module:<module>",
    host: "Node HTTP adapter",
    construct: nodeHttpImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: processUmask,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/main.ts",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: "runner:NodeRuntime.runMain",
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/runtime/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/runtime/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/runtime/node-process-control.ts",
    declaration: "member:nodeProcessControlLayer.currentPid",
    host: "Node ProcessControl host acquisition",
    construct: processPid,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/runtime/node-process-control.ts",
    declaration: "member:probe.try",
    host: "Node ProcessControl host acquisition",
    construct: processKill,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/test/fixtures/state-root-lock-contender.ts",
    declaration: "module:<module>",
    host: "Test fixture entrypoint",
    construct: testFixtureNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/test/fixtures/trust-boundary-host.ts",
    declaration: "module:<module>",
    host: "Trust-boundary network-target test fixture host adapter",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/test/fixtures/trust-boundary-host.ts",
    declaration: "variable:program",
    host: "Trust-boundary permissive-umask test fixture host setup",
    construct: processUmask,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/server/test/fixtures/trust-boundary-host.ts",
    declaration: "module:<module>",
    host: "Argument-selected trust-boundary test fixture entrypoint",
    construct: testFixtureNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/main.tsx",
    declaration: "module:<module>",
    host: "Node application entrypoint",
    construct: desktopNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/runtime/tui-runtime.ts",
    declaration: "member:backendCommand.binaryArgs",
    host: "Node backend executable acquisition",
    construct: processExecPath,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/runtime/tui-runtime.ts",
    declaration: "member:backendCommand.execPath",
    host: "Node backend executable acquisition",
    construct: processExecPath,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/runtime/tui-runtime.ts",
    declaration: "module:<module>",
    host: "Node backend executable path adapter",
    construct: nodePathImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/runtime/tui-runtime.ts",
    declaration: "module:<module>",
    host: "Node backend executable URL adapter",
    construct: nodeUrlImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/runtime/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "apps/tui/runtime/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "bench/main.ts",
    declaration: "module:<module>",
    host: "Benchmark Node host adapter",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "bench/main.ts",
    declaration: "member:opts.try",
    host: "Benchmark command-line argument acquisition",
    construct: processArgv,
    occurrence: 0
  }),
  Object.freeze({
    file: "bench/main.ts",
    declaration: "member:benchmarkHostLayer.rss",
    host: "Benchmark RSS host adapter",
    construct: processMemoryUsage,
    occurrence: 0
  }),
  Object.freeze({
    file: "bench/main.ts",
    declaration: "member:benchmarkHostLayer.nodeVersion",
    host: "Benchmark machine metadata host adapter",
    construct: processVersion,
    occurrence: 0
  }),
  Object.freeze({
    file: "bench/main.ts",
    declaration: "module:<module>",
    host: "Benchmark application entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "bench/selfcheck.ts",
    declaration: "module:<module>",
    host: "Benchmark selfcheck entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/archive-stale.ts",
    declaration: "module:<module>",
    host: "Client example entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/audit-log.ts",
    declaration: "module:<module>",
    host: "Client example entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/bootstrap-projects.ts",
    declaration: "module:<module>",
    host: "Client example entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/node-app-context.ts",
    declaration: "module:<module>",
    host: "Node AppContext host acquisition",
    construct: nodeOsImport,
    occurrence: 0
  }),
  Object.freeze({
    file: "examples/client-ts/node-app-context.ts",
    declaration: "member:cwd.try",
    host: "Node AppContext host acquisition",
    construct: processCwd,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/contract.ts",
    declaration: "type:IpcBridgeOf",
    host: "Electron renderer invoke Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "module:<module>",
    host: "Electron IPC host adapter",
    construct: "platform:import:electron",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "module:<module>",
    host: "Electron IPC host adapter types",
    construct: "platform:import:electron",
    occurrence: 1
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "member:electronBindDeps.on",
    host: "Electron IPC listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "member:electronBindDeps.on",
    host: "Electron IPC listener disposal",
    construct: "platform:listener.off",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "variable:wrapper",
    host: "Electron IPC invoke Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "member:electronBindDeps.handle",
    host: "Electron IPC invoke registration",
    construct: "platform:electron.ipcMain.handle",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main-electron.ts",
    declaration: "member:electronBindDeps.handle",
    host: "Electron IPC invoke disposal",
    construct: "platform:electron.ipcMain.removeHandler",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main.ts",
    declaration: "member:IpcMainLike.handle",
    host: "Electron IPC invoke Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main.ts",
    declaration: "variable:invokeHandler",
    host: "Electron IPC invoke Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main.ts",
    declaration: "variable:runPromise",
    host: "Electron IPC invoke Promise runtime",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/main.ts",
    declaration: "variable:silentInvoke",
    host: "Electron IPC silent invoke Promise ABI",
    construct: "signature:Promise",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "module:<module>",
    host: "Electron preload host adapter",
    construct: "platform:import:electron",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "module:<module>",
    host: "Electron preload host adapter types",
    construct: "platform:import:electron",
    occurrence: 1
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.send",
    host: "Electron renderer IPC send",
    construct: "platform:electron.ipcRenderer.send",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.invoke",
    host: "Electron renderer invoke Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.invoke",
    host: "Electron renderer IPC invoke",
    construct: "platform:electron.ipcRenderer.invoke",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.on",
    host: "Electron renderer IPC listener",
    construct: "platform:listener.on",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.on",
    host: "Electron renderer IPC listener disposal",
    construct: "platform:listener.removeListener",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.exposeInMainWorld",
    host: "Electron context bridge exposure",
    construct: "platform:electron.contextBridge.exposeInMainWorld",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "variable:origin",
    host: "Preload main-world target origin",
    construct: windowLocation,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.postToMainWorld",
    host: "Preload main-world port relay",
    construct: windowPostMessage,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "variable:release",
    host: "Preload unload listener disposal",
    construct: "platform:listener.removeEventListener",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload-electron.ts",
    declaration: "member:electronPreloadDeps.onContextDisposed",
    host: "Preload unload listener",
    construct: "platform:listener.addEventListener",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload.ts",
    declaration: "member:PreloadIpcDeps.invoke",
    host: "Electron renderer invoke Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/preload.ts",
    declaration: "variable:exposeBridge",
    host: "Electron renderer invoke bridge ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/renderer.ts",
    declaration: "member:browserCrypto.randomBytes",
    host: "Browser Crypto random-byte adapter",
    construct: "platform:crypto.getRandomValues",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/renderer.ts",
    declaration: "member:browserCrypto.try",
    host: "Browser SubtleCrypto digest adapter",
    construct: "platform:crypto.subtle",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/electron-ipc/renderer.ts",
    declaration: "member:browserCrypto.try",
    host: "Browser SubtleCrypto digest Promise ABI",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node-process-control.ts",
    declaration: "member:nodeProcessControlLayer.currentPid",
    host: "Node ProcessControl host acquisition",
    construct: processPid,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node-process-control.ts",
    declaration: "member:probe.try",
    host: "Node ProcessControl host acquisition",
    construct: processKill,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node.ts",
    declaration: "module:<module>",
    host: "Node WebSocket adapter",
    construct: "platform:import:ws",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/adapters/node.ts",
    declaration: "variable:wsConstructor",
    host: "Node WebSocket adapter",
    construct: "platform:ws.WebSocket",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/scripts/prepare-publish.ts",
    declaration: "module:<module>",
    host: "Client package publish entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/test/fixtures/spawn-lock-contender.ts",
    declaration: "module:<module>",
    host: "Test fixture entrypoint",
    construct: testFixtureNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/client-ts/test/prepare-publish.test.ts",
    declaration: "variable:module",
    host: "Vitest controlled dynamic import",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/contracts/scripts/prepare-publish.ts",
    declaration: "module:<module>",
    host: "Contracts package publish entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "packages/contracts/test/prepare-publish.test.ts",
    declaration: "variable:module",
    host: "Vitest controlled dynamic import",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "docs/architecture/scripts/build.ts",
    declaration: "module:<module>",
    host: "Architecture documentation build entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "docs/architecture/scripts/build.test.ts",
    declaration: "variable:module",
    host: "Vitest controlled dynamic import",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/build.test.ts",
    declaration: "variable:module",
    host: "Vitest controlled dynamic import",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/build.ts",
    declaration: "member:buildTool.try",
    host: "esbuild Promise adapter",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/build.ts",
    declaration: "module:<module>",
    host: "Node build entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/binary-smoke.ts",
    declaration: "module:<module>",
    host: "CLI binary certification entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/desktop-command.test.ts",
    declaration: "variable:module",
    host: "Vitest controlled dynamic import",
    construct: "signature:PromiseLike",
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/desktop-command.ts",
    declaration: "module:<module>",
    host: "Desktop development command entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/fold-version.ts",
    declaration: "module:<module>",
    host: "Node fold-version entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "scripts/package-certification.ts",
    declaration: "module:<module>",
    host: "Package certification entrypoint",
    construct: scriptNodeRuntimeRunMain,
    occurrence: 0
  }),
  Object.freeze({
    file: "test/architecture/client-ts-barrel.test.ts",
    declaration: "module:<module>",
    host: "Architecture package export resolution",
    construct: "platform:import:node:module",
    occurrence: 0
  }),
  Object.freeze({
    file: "test/architecture/depcruise-exclude.test.ts",
    declaration: "module:<module>",
    host: "Architecture dependency-cruiser resolution",
    construct: "platform:import:node:module",
    occurrence: 0
  }),
  Object.freeze({
    file: "test/architecture/fold-version-lockstep.test.ts",
    declaration: "variable:module",
    host: "Vitest controlled dynamic import",
    construct: "signature:PromiseLike",
    occurrence: 0
  })
])
