import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Stream } from "effect"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, vi } from "vitest"
import { BootError } from "@expand/desktop/renderer/app/BootError"
import { ownRendererRoot } from "@expand/desktop/renderer/app/root"
import {
  RendererRunnerProvider,
  useRendererRunner
} from "@expand/desktop/renderer/app/runner-context"
import type { RendererRunner } from "@expand/desktop/renderer/app/runner"
import {
  ProjectContextProvider,
  useProjectRpc
} from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import type { ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"

const runner: RendererRunner = {
  start: () => () => {}
}

const rpc: ProjectRpcApi = {
  create: () => Effect.never,
  rename: () => Effect.never,
  changeDirectory: () => Effect.never,
  archive: () => Effect.never,
  restore: () => Effect.never,
  setMetadata: () => Effect.never,
  delete: () => Effect.never,
  list: () => Effect.never,
  status: Stream.never,
  events: () => Stream.never
}

const captureThrow = (operation: () => unknown): unknown => {
  try {
    operation()
  } catch (error) {
    return error
  }
  throw new Error("operation did not throw")
}

interface RootHarnessOptions {
  readonly events?: Array<string>
  readonly renderError?: Error
  readonly registrationError?: Error
  readonly startError?: Error
  readonly releaseError?: Error
  readonly unmountError?: Error
  readonly interruptError?: Error
  readonly failDuringRelease?: boolean
}

const makeRootHarness = (options: RootHarnessOptions = {}) => {
  const events = options.events ?? []
  const renders: Array<React.ReactNode> = []
  let activeDispose: (() => void) | undefined
  let retainedDispose: (() => void) | undefined
  let hmrDispose: (() => void) | undefined
  let rootExit: ((exit: Exit.Exit<never, string>) => void) | undefined
  const retry = vi.fn()
  const root = {
    render: (node: React.ReactNode) => {
      events.push("render")
      renders.push(node)
      if (options.renderError !== undefined) throw options.renderError
    },
    unmount: () => {
      events.push("unmount")
      if (options.unmountError !== undefined) throw options.unmountError
    }
  }
  const onDispose = (dispose: () => void) => {
    events.push("register")
    activeDispose = dispose
    retainedDispose = dispose
    hmrDispose = dispose
    if (options.registrationError !== undefined) {
      events.push("release")
      activeDispose = undefined
      throw options.registrationError
    }
    return () => {
      events.push("release")
      activeDispose = undefined
      if (options.failDuringRelease === true) rootExit?.(Exit.fail("late failure"))
      if (options.releaseError !== undefined) throw options.releaseError
    }
  }
  const start = (onExit: (exit: Exit.Exit<never, string>) => void) => {
    events.push("start")
    rootExit = onExit
    if (options.startError !== undefined) throw options.startError
    return () => {
      events.push("interrupt")
      if (options.interruptError !== undefined) throw options.interruptError
    }
  }
  const dispose = ownRendererRoot({
    root,
    initial: <p>Connecting…</p>,
    start,
    onDispose,
    renderFailure: (cause) => <BootError message={Cause.pretty(cause)} onRetry={retry} />
  })
  return {
    dispose,
    events,
    renders,
    retry,
    rootExit: (exit: Exit.Exit<never, string>) => rootExit?.(exit),
    fireUnload: () => activeDispose?.(),
    fireRetainedUnload: () => retainedDispose?.(),
    fireHmr: () => hmrDispose?.(),
    registeredIdentity: () => ({ activeDispose, retainedDispose, hmrDispose })
  }
}

describe("renderer runner context", () => {
  it.effect("keeps the runner and project providers independent", () =>
    Effect.sync(() => {
      const store = makeProjectsStore()
      let observedRunner: RendererRunner | undefined
      let observedRpc: ProjectRpcApi | undefined
      const ReadContexts = () => {
        observedRunner = useRendererRunner()
        observedRpc = useProjectRpc()
        return null
      }
      renderToStaticMarkup(
        <RendererRunnerProvider value={runner}>
          <ProjectContextProvider value={{ store, rpc }}>
            <ReadContexts />
          </ProjectContextProvider>
        </RendererRunnerProvider>
      )
      expect(observedRunner).toBe(runner)
      expect(observedRpc).toBe(rpc)
      expect(Object.keys({ store, rpc })).toEqual(["store", "rpc"])
    }))

  it.effect("fails precisely when the runner provider is missing", () =>
    Effect.sync(() => {
      const ReadRunner = () => {
        useRendererRunner()
        return null
      }
      expect(() => renderToStaticMarkup(<ReadRunner />)).toThrow(
        "renderer runner must be used within <RendererRunnerProvider>"
      )
    }))
})

describe("renderer root ownership", () => {
  it.effect("renders one active non-interruption failure and ignores interruption", () =>
    Effect.sync(() => {
      const harness = makeRootHarness()
      harness.rootExit(Exit.interrupt())
      expect(harness.renders).toHaveLength(1)
      harness.rootExit(Exit.fail("boot failed"))
      expect(harness.renders).toHaveLength(2)
      expect(renderToStaticMarkup(harness.renders[1])).toContain("boot failed")
      harness.dispose()
    }))

  it.effect("shares one exact idempotent disposer across unload and HMR", () =>
    Effect.sync(() => {
      const harness = makeRootHarness()
      const identities = harness.registeredIdentity()
      expect(identities.activeDispose).toBe(identities.retainedDispose)
      expect(identities.activeDispose).toBe(identities.hmrDispose)
      harness.fireUnload()
      harness.fireHmr()
      harness.fireRetainedUnload()
      harness.dispose()
      expect(harness.events.filter((event) => event === "release")).toHaveLength(1)
      expect(harness.events.filter((event) => event === "unmount")).toHaveLength(1)
      expect(harness.events.filter((event) => event === "interrupt")).toHaveLength(1)
    }))

  it.effect("deactivates before listener release, unmount, and root interruption", () =>
    Effect.sync(() => {
      const harness = makeRootHarness({ failDuringRelease: true })
      harness.dispose()
      expect(harness.events.slice(-3)).toEqual(["release", "unmount", "interrupt"])
      expect(harness.renders).toHaveLength(1)
      harness.rootExit(Exit.fail("later failure"))
      expect(harness.renders).toHaveLength(1)
    }))

  it.effect("attempts interruption after cleanup defects and preserves cause order", () =>
    Effect.sync(() => {
      const releaseError = new Error("release failed")
      const unmountError = new Error("unmount failed")
      const interruptError = new Error("interrupt failed")
      const single = makeRootHarness({ releaseError })
      expect(captureThrow(single.dispose)).toBe(releaseError)
      expect(single.events.slice(-3)).toEqual(["release", "unmount", "interrupt"])
      const multiple = makeRootHarness({ releaseError, unmountError, interruptError })
      const thrown = captureThrow(multiple.dispose)
      expect(thrown).toBeInstanceOf(AggregateError)
      if (!(thrown instanceof AggregateError)) throw thrown
      expect(thrown.errors).toEqual([releaseError, unmountError, interruptError])
      expect(multiple.events.slice(-3)).toEqual(["release", "unmount", "interrupt"])
    }))

  it.effect("rolls back initial render, registration, and startup failures", () =>
    Effect.sync(() => {
      const renderError = new Error("render failed")
      const renderEvents: Array<string> = []
      expect(captureThrow(() => makeRootHarness({ events: renderEvents, renderError }))).toBe(renderError)
      expect(renderEvents).toEqual(["render", "unmount"])
      const registrationError = new Error("registration failed")
      const registrationEvents: Array<string> = []
      expect(captureThrow(() => makeRootHarness({
        events: registrationEvents,
        registrationError
      }))).toBe(registrationError)
      expect(registrationEvents).toEqual(["render", "register", "release", "unmount"])
      const startError = new Error("start failed")
      const startEvents: Array<string> = []
      expect(captureThrow(() => makeRootHarness({ events: startEvents, startError }))).toBe(startError)
      expect(startEvents).toEqual(["render", "register", "start", "release", "unmount"])
      const releaseError = new Error("rollback release failed")
      const unmountError = new Error("rollback unmount failed")
      const aggregateEvents: Array<string> = []
      const thrown = captureThrow(() => makeRootHarness({
        events: aggregateEvents,
        startError,
        releaseError,
        unmountError
      }))
      expect(thrown).toBeInstanceOf(AggregateError)
      if (!(thrown instanceof AggregateError)) throw thrown
      expect(thrown.errors).toEqual([startError, releaseError, unmountError])
      expect(aggregateEvents).toEqual(["render", "register", "start", "release", "unmount"])
    }))
})
