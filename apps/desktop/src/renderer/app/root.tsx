import type { ReactNode } from "react"
import { Cause, Exit } from "effect"

export interface RendererReactRoot {
  readonly render: (node: ReactNode) => void
  readonly unmount: () => void
}

export interface RendererRootOptions<E> {
  readonly root: RendererReactRoot
  readonly initial: ReactNode
  readonly start: (onExit: (exit: Exit.Exit<never, E>) => void) => () => void
  readonly onDispose: (dispose: () => void) => () => void
  readonly renderFailure: (cause: Cause.Cause<E>) => ReactNode
}

export const ownRendererRoot = <E,>({
  root,
  initial,
  start,
  onDispose,
  renderFailure
}: RendererRootOptions<E>): (() => void) => {
  const attempt = (operation: () => void, errors: Array<unknown>): void => {
    try {
      operation()
    } catch (error) {
      errors.push(error)
    }
  }
  const raise = (errors: ReadonlyArray<unknown>): void => {
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "renderer root cleanup failed")
  }
  let active = true
  let disposed = false
  let rendered = false
  let releaseDispose: (() => void) | undefined
  let interruptRoot: (() => void) | undefined
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    active = false
    const errors: Array<unknown> = []
    if (releaseDispose !== undefined) {
      const release = releaseDispose
      releaseDispose = undefined
      attempt(release, errors)
    }
    if (rendered) {
      rendered = false
      attempt(root.unmount, errors)
    }
    if (interruptRoot !== undefined) {
      const interrupt = interruptRoot
      interruptRoot = undefined
      attempt(interrupt, errors)
    }
    raise(errors)
  }
  try {
    rendered = true
    root.render(initial)
    const release = onDispose(dispose)
    if (disposed) {
      release()
      return dispose
    }
    releaseDispose = release
    interruptRoot = start((exit) => {
      if (!active || Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return
      root.render(renderFailure(exit.cause))
    })
    return dispose
  } catch (error) {
    active = false
    disposed = true
    const errors: Array<unknown> = [error]
    if (releaseDispose !== undefined) {
      const release = releaseDispose
      releaseDispose = undefined
      attempt(release, errors)
    }
    if (rendered) {
      rendered = false
      attempt(root.unmount, errors)
    }
    if (interruptRoot !== undefined) {
      const interrupt = interruptRoot
      interruptRoot = undefined
      attempt(interrupt, errors)
    }
    raise(errors)
    return dispose
  }
}
