import { beforeEach, describe, expect, vi } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import type { MainProgramDeps } from "@expand/desktop/main/application/main-program"
import { windowOptions } from "@expand/desktop/main/security/window-options"
import "@expand/desktop/main/index"

const program = vi.hoisted(() => {
  interface InertProgram {
    readonly pipe: (...operations: ReadonlyArray<unknown>) => InertProgram
  }

  let captured: MainProgramDeps | undefined
  const inert: InertProgram = {
    pipe: () => inert
  }

  return {
    mainProgram: (deps: MainProgramDeps) => {
      captured = deps
      return inert
    },
    deps: () => {
      if (captured === undefined) throw new Error("main program dependencies were not captured")
      return captured
    }
  }
})

const electron = vi.hoisted(() => {
  type Listener = (...arguments_: Array<unknown>) => void

  interface ListenerRecord {
    readonly event: string
    readonly listener: Listener
  }

  class FakeWebContents {
    readonly listeners = new Map<string, Listener>()
    readonly registrations: Array<ListenerRecord> = []
    readonly offAttempts: Array<ListenerRecord> = []
    readonly removals: Array<ListenerRecord> = []
    readonly offFailures = new Map<string, Error>()
    readonly mainFrame = { url: "file:///app/index.html", detached: false }
    openHandler: unknown
    destroyed = false

    on(event: string, listener: Listener) {
      this.listeners.set(event, listener)
      this.registrations.push({ event, listener })
    }

    off(event: string, listener: Listener) {
      this.offAttempts.push({ event, listener })
      if (this.destroyed) throw new Error("web contents has been destroyed")
      const failure = this.offFailures.get(event)
      if (failure !== undefined) throw failure
      this.removals.push({ event, listener })
      if (this.listeners.get(event) === listener) this.listeners.delete(event)
    }

    isDestroyed() {
      return this.destroyed
    }

    setWindowOpenHandler(handler: unknown) {
      this.openHandler = handler
    }

    postMessage() {}
  }

  const windows: Array<FakeBrowserWindow> = []
  const utilityForks: Array<{
    readonly modulePath: string
    readonly args: ReadonlyArray<string>
    readonly options: unknown
  }> = []

  class FakeBrowserWindow {
    readonly contents = new FakeWebContents()
    readonly listeners = new Map<string, Listener>()
    readonly registrations: Array<ListenerRecord> = []
    readonly offAttempts: Array<ListenerRecord> = []
    readonly removals: Array<ListenerRecord> = []
    getterReads = 0
    destroyed = false

    constructor(_options: unknown) {
      windows.push(this)
    }

    get webContents() {
      this.getterReads += 1
      if (this.destroyed) throw new Error("browser window has been destroyed")
      return this.contents
    }

    on(event: string, listener: Listener) {
      this.listeners.set(event, listener)
      this.registrations.push({ event, listener })
    }

    off(event: string, listener: Listener) {
      this.offAttempts.push({ event, listener })
      if (this.destroyed) throw new Error("browser window has been destroyed")
      this.removals.push({ event, listener })
      if (this.listeners.get(event) === listener) this.listeners.delete(event)
    }

    isDestroyed() {
      return this.destroyed
    }

    destroy() {
      this.destroySources()
    }

    destroySources() {
      const closed = this.listeners.get("closed")
      this.contents.destroyed = true
      this.destroyed = true
      closed?.()
    }

    loadURL() {}

    loadFile() {}
  }

  const reset = () => {
    windows.length = 0
    utilityForks.length = 0
  }

  const currentWindow = () => {
    const current = windows.at(-1)
    if (current === undefined) throw new Error("browser window was not constructed")
    return current
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    MessageChannelMain: class {},
    app: {
      getAppPath: () => "/staged/Expand/resources/app.asar",
      isPackaged: false,
      whenReady: () => undefined,
      commandLine: { appendSwitch: () => {} },
      disableHardwareAcceleration: () => {},
      on: () => {},
      off: () => {},
      quit: () => {}
    },
    session: {
      defaultSession: {
        webRequest: { onHeadersReceived: () => {} }
      }
    },
    utilityProcess: {
      fork: (modulePath: string, args: ReadonlyArray<string>, options: unknown) => {
        utilityForks.push({ modulePath, args, options })
        const child = {
          kill: () => true,
          once: (_event: string, listener: () => void) => {
            listener()
            return child
          }
        }
        return child
      }
    },
    utilityForks,
    reset,
    currentWindow
  }
})

const binding = vi.hoisted(() => {
  const calls: Array<{ readonly contract: unknown; readonly handlers: unknown; readonly options: { readonly window: unknown; readonly rendererOrigin?: string; readonly rendererUrl?: string } }> = []

  return {
    calls,
    reset: () => {
      calls.length = 0
    },
    bindElectronIpc: (contract: unknown, handlers: unknown, options: { readonly window: unknown; readonly rendererOrigin?: string; readonly rendererUrl?: string }) => {
      calls.push({ contract, handlers, options })
      return Effect.void
    }
  }
})

const runtime = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
  makeRuntime: (host: unknown) => {
    runtime.calls.push(host)
    return {}
  },
  reset: () => {
    runtime.calls.length = 0
  }
}))

const platform = vi.hoisted(() => ({
  NodePath: { layer: {} },
  NodeRuntime: { runMain: () => {} }
}))

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  MessageChannelMain: electron.MessageChannelMain,
  session: electron.session,
  utilityProcess: electron.utilityProcess
}))

vi.mock("@expand/desktop/main/application/main-program", () => ({ mainProgram: program.mainProgram }))
vi.mock("@expand/desktop/main/runtime/client-runtime", () => ({ makeRuntime: runtime.makeRuntime }))
vi.mock("@expand/electron-ipc/main", () => ({ bindElectronIpc: binding.bindElectronIpc }))
vi.mock("@effect/platform-node", () => platform)

const listenerFor = (
  records: ReadonlyArray<{ readonly event: string; readonly listener: (...arguments_: Array<unknown>) => void }>,
  event: string
) => {
  const record = records.find((candidate) => candidate.event === event)
  if (record === undefined) throw new Error(`missing ${event} listener`)
  return record.listener
}

const makeWindowHost = Effect.fn("DesktopMainHostTest.makeWindowHost")(function* () {
  const host = program.deps().createWindow(windowOptions("/app/preload.cjs"))
  const browserWindow = electron.currentWindow()
  yield* Effect.scoped(host.bindIpc(
    { _tag: "url", value: "file:///app/index.html" },
    { rpcPort: (_sender, _grant) => Effect.void }
  ))
  return { host, browserWindow, webContents: browserWindow.contents }
})

beforeEach(() => {
  electron.reset()
  binding.reset()
  runtime.reset()
})

describe("desktop main window host", () => {
  it.effect("passes the packaged backend location and utility-process launcher to the runtime", () =>
    Effect.gen(function*() {
      program.deps().makeRuntime()
      const host = runtime.calls[0] as {
        readonly backendEntry: string
        readonly isPackaged: boolean
        readonly moduleUrl: URL
        readonly awaitPackagedBackendShutdown: Effect.Effect<void>
        readonly spawnPackagedBackend: (
          backendEntry: string,
          dataDir: string
        ) => Effect.Effect<void, unknown>
      }
      expect(host).toMatchObject({
        backendEntry: "/staged/Expand/resources/app.asar/build/backend.mjs",
        isPackaged: false,
        moduleUrl: expect.any(URL),
        awaitPackagedBackendShutdown: expect.anything(),
        spawnPackagedBackend: expect.any(Function)
      })
      yield* host.spawnPackagedBackend(host.backendEntry, "/state")
      expect(electron.utilityForks).toEqual([{
        modulePath: "/staged/Expand/resources/app.asar/build/backend.mjs",
        args: ["--data-dir", "/state"],
        options: { serviceName: "Expand Backend", stdio: "ignore" }
      }])
    }))

  it.effect("passes an origin identity to the public IPC binder without widening it to a URL", () => Effect.gen(function* () {
    const { host, browserWindow } = yield* makeWindowHost()
    yield* Effect.scoped(host.bindIpc(
      { _tag: "origin", value: "http://localhost:5173" },
      { rpcPort: (_sender, _grant) => Effect.void }
    ))

    expect(binding.calls[1]?.options).toEqual({
      window: browserWindow,
      rendererOrigin: "http://localhost:5173"
    })
  }))

  it.effect("skips exact listener removal after Electron destroys both sources", () => Effect.gen(function* () {
    const { host, browserWindow, webContents } = yield* makeWindowHost()
    const disposeClosed = host.onClosed(() => {})
    const disposeNavigation = host.onNavigation(() => {})
    const disposeWillNavigate = host.onWillNavigate(() => {})
    const openHandler = (): { readonly action: "deny" } => ({ action: "deny" })
    host.setWindowOpenHandler(openHandler)

    expect(binding.calls).toHaveLength(1)
    expect(binding.calls[0]?.contract).toMatchObject({ prefix: "expand" })
    expect(binding.calls[0]?.options).toEqual({ window: browserWindow, rendererUrl: "file:///app/index.html" })
    expect(webContents.openHandler).toBe(openHandler)

    browserWindow.destroySources()

    expect(() => {
      disposeClosed()
      disposeNavigation()
      disposeWillNavigate()
      disposeClosed()
      disposeNavigation()
      disposeWillNavigate()
    }).not.toThrow()
    expect(browserWindow.getterReads).toBe(1)
    expect(browserWindow.offAttempts).toEqual([])
    expect(webContents.offAttempts).toEqual([])
  }))

  it.effect("removes each exact live listener wrapper once", () => Effect.gen(function* () {
    const { host, browserWindow, webContents } = yield* makeWindowHost()
    const closed = () => {}
    const disposeClosed = host.onClosed(closed)
    const disposeNavigation = host.onNavigation(() => {})
    const disposeWillNavigate = host.onWillNavigate(() => {})
    const didStartNavigation = listenerFor(webContents.registrations, "did-start-navigation")
    const willNavigate = listenerFor(webContents.registrations, "will-navigate")

    disposeClosed()
    disposeNavigation()
    disposeWillNavigate()
    disposeClosed()
    disposeNavigation()
    disposeWillNavigate()

    expect(browserWindow.removals).toEqual([{ event: "closed", listener: closed }])
    expect(webContents.removals).toEqual([
      { event: "did-start-navigation", listener: didStartNavigation },
      { event: "will-navigate", listener: willNavigate }
    ])
    expect(browserWindow.offAttempts).toEqual(browserWindow.removals)
    expect(webContents.offAttempts).toEqual(webContents.removals)
    expect(browserWindow.getterReads).toBe(1)
  }))

  it.effect("propagates a live web contents removal defect", () => Effect.gen(function* () {
    const { host, webContents } = yield* makeWindowHost()
    const defect = new Error("live removal failed")
    const disposeNavigation = host.onNavigation(() => {})
    webContents.offFailures.set("did-start-navigation", defect)

    expect(disposeNavigation).toThrow(defect)
    expect(webContents.offAttempts).toHaveLength(1)
    expect(webContents.removals).toEqual([])
  }))
})
