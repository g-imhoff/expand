import { useCallback, useEffect, useState } from "react"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import type { DomainEvent } from "@expand/contracts/events/domain"
import type { RunMetrics, RunRecord, RoutineRecord } from "@expand/contracts/rpc/automation-schemas"
import { useRendererRunner } from "@expand/desktop/renderer/app/runner-context"
import { useAutomationRpc } from "@expand/desktop/renderer/features/automations/data/automation-context"
import { automationScope, type AutomationScope } from "@expand/desktop/renderer/features/automations/data/automation-scope"

export interface AutomationOverviewData {
  readonly routines: ReadonlyArray<RoutineRecord>
  readonly runs: ReadonlyArray<RunRecord>
  readonly metrics: RunMetrics
}

export interface AutomationOverviewModel {
  readonly status: "loading" | "ready" | "error"
  readonly data: AutomationOverviewData | null
  readonly error: string | null
  readonly live: boolean
  readonly refresh: () => void
}

export const useAutomationOverview = (projectId: string): AutomationOverviewModel => {
  const runner = useRendererRunner()
  const rpc = useAutomationRpc()
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>({ status: "loading", data: null, error: null })
  const [live, setLive] = useState(false)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (rpc === null) {
      setSnapshot({ status: "error", data: null, error: UNAVAILABLE_MESSAGE })
      return
    }
    const scope = automationScope(projectId)
    let active = true
    setSnapshot((previous) =>
      previous.data === null
        ? { status: "loading", data: null, error: null }
        : { ...previous, error: null })
    const cancel = runner.start(
      Effect.all({
        routines: rpc.routineList({ scope }).pipe(Effect.map((result) => result.routines)),
        page: rpc.runList({ scope, limit: RECENT_RUN_LIMIT }),
        metrics: rpc.runMetrics({ scope })
      }),
      (exit) => {
        if (!active) return
        if (Exit.isSuccess(exit)) {
          setSnapshot({
            status: "ready",
            data: { routines: exit.value.routines, runs: exit.value.page.runs, metrics: exit.value.metrics },
            error: null
          })
          return
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return
        const message = describeFailure(exit.cause)
        setSnapshot((previous) =>
          previous.data === null
            ? { status: "error", data: null, error: message }
            : { ...previous, error: message })
      }
    )
    return () => {
      active = false
      cancel()
    }
  }, [runner, rpc, projectId, generation])

  useEffect(() => {
    if (rpc === null) {
      setLive(false)
      return
    }
    const scope = automationScope(projectId)
    let cancelled = false
    let cancelCurrent: (() => void) | undefined = undefined
    let cancelRetry: (() => void) | undefined = undefined
    let lastSeq: number | undefined = undefined
    const scheduleResubscribe = (): void => {
      if (cancelled) return
      setLive(false)
      cancelRetry = runner.start(
        Effect.sleep(RESUBSCRIBE_DELAY).pipe(Effect.andThen(Effect.sync(subscribe))),
        () => {}
      )
    }
    const subscribe = (): void => {
      if (cancelled) return
      setLive(true)
      cancelCurrent = runner.start(
        rpc.events(lastSeq === undefined ? {} : { fromSeq: lastSeq }).pipe(
          Stream.runForEach((sequenced) =>
            Effect.sync(() => {
              if (lastSeq === undefined || sequenced.seq > lastSeq) lastSeq = sequenced.seq
              if (isWatchedEvent(sequenced.event, scope)) refresh()
            }))
        ),
        (exit) => {
          cancelCurrent = undefined
          if (cancelled) return
          if (Exit.isSuccess(exit) || !Cause.hasInterruptsOnly(exit.cause)) scheduleResubscribe()
        }
      )
    }
    subscribe()
    return () => {
      cancelled = true
      cancelCurrent?.()
      cancelRetry?.()
    }
  }, [runner, rpc, projectId, refresh])

  return { status: snapshot.status, data: snapshot.data, error: snapshot.error, live, refresh }
}

interface OverviewSnapshot {
  readonly status: "loading" | "ready" | "error"
  readonly data: AutomationOverviewData | null
  readonly error: string | null
}

const RECENT_RUN_LIMIT = 10

const RESUBSCRIBE_DELAY = "1 second"

const UNAVAILABLE_MESSAGE = "Automation data isn't available."

const isWatchedEvent = (event: DomainEvent, scope: AutomationScope): boolean => {
  switch (event._tag) {
    case "AutomationRunChanged":
    case "AutomationRoutineChanged":
      return event.projectId === scope.projectId && event.ownerId === scope.ownerId
    default:
      return false
  }
}

const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure)) return "Automation data couldn't be loaded."
  const value: unknown = failure.value
  if (typeof value === "string") return value
  if (value instanceof Error && value.message.length > 0) return value.message
  if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string" && value.message.length > 0) {
    if ("_tag" in value && typeof value._tag === "string") return `${value._tag}: ${value.message}`
    return value.message
  }
  return "Automation data couldn't be loaded."
}
