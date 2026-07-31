import { beforeEach, describe, expect, it, vi } from "vitest"
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
    reset,
    currentWindow
  }
})

const binding = vi.hoisted(() => {
  interface WindowLike {
    readonly webContents: unknown
  }

  const targets: Array<WindowLike> = []
  const boundContents: Array<unknown> = []

  return {
    targets,
    boundContents,
    reset: () => {
      targets.length = 0
      boundContents.length = 0
    },
    electronBindDeps: (target: WindowLike) => {
      const webContents = target.webContents
      targets.push(target)
      boundContents.push(webContents)
      return {
        ipc: {
          on: () => () => {},
          handle: () => () => {}
        },
        target: {
          webContents,
          mainFrame: null,
          postToRenderer: () => {}
        }
      }
    }
  }
})

const platform = vi.hoisted(() => ({
  NodePath: { layer: {} },
  NodeRuntime: { runMain: () => {} }
}))

vi.mock("electron", () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  MessageChannelMain: electron.MessageChannelMain,
  session: electron.session
}))

vi.mock("@expand/desktop/main/application/main-program", () => ({ mainProgram: program.mainProgram }))
vi.mock("@expand/desktop/main/runtime/client-runtime", () => ({ makeRuntime: () => ({}) }))
vi.mock("@expand/electron-ipc/main-electron", () => ({ electronBindDeps: binding.electronBindDeps }))
vi.mock("@effect/platform-node", () => platform)

const listenerFor = (
  records: ReadonlyArray<{ readonly event: string; readonly listener: (...arguments_: Array<unknown>) => void }>,
  event: string
) => {
  const record = records.find((candidate) => candidate.event === event)
  if (record === undefined) throw new Error(`missing ${event} listener`)
  return record.listener
}

const makeWindowHost = () => {
  const host = program.deps().createWindow(windowOptions("/app/preload.cjs"))
  const browserWindow = electron.currentWindow()
  return { host, browserWindow, webContents: browserWindow.contents }
}

beforeEach(() => {
  electron.reset()
  binding.reset()
})

describe("desktop main window host", () => {
  it("skips exact listener removal after Electron destroys both sources", () => {
    const { host, browserWindow, webContents } = makeWindowHost()
    const disposeClosed = host.onClosed(() => {})
    const disposeNavigation = host.onNavigation(() => {})
    const disposeWillNavigate = host.onWillNavigate(() => {})
    const openHandler = (): { readonly action: "deny" } => ({ action: "deny" })
    host.setWindowOpenHandler(openHandler)

    expect(binding.boundContents).toStrictEqual([webContents])
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
    expect(binding.targets).toHaveLength(1)
    expect(binding.targets[0]).not.toBe(browserWindow)
    expect(browserWindow.getterReads).toBe(1)
    expect(browserWindow.offAttempts).toEqual([])
    expect(webContents.offAttempts).toEqual([])
  })

  it("removes each exact live listener wrapper once", () => {
    const { host, browserWindow, webContents } = makeWindowHost()
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
  })

  it("propagates a live web contents removal defect", () => {
    const { host, webContents } = makeWindowHost()
    const defect = new Error("live removal failed")
    const disposeNavigation = host.onNavigation(() => {})
    webContents.offFailures.set("did-start-navigation", defect)

    expect(disposeNavigation).toThrow(defect)
    expect(webContents.offAttempts).toHaveLength(1)
    expect(webContents.removals).toEqual([])
  })
})
