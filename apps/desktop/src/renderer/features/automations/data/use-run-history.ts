import { useCallback, useEffect, useRef, useState } from "react"
import { Cause, Effect, Exit, Option } from "effect"
import type { RoutineRecord, RunHistory, RunRecord } from "@expand/contracts/rpc/automation-schemas"
import type { RendererCancel } from "@expand/desktop/renderer/app/runner"
import { useRendererRunner } from "@expand/desktop/renderer/app/runner-context"
import { useOptionalAutomationRpc } from "@expand/desktop/renderer/features/automations/data/automation-run-context"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import {
  automationScopeForProject,
  runStateForFilter,
  type RunOutcomeFilter
} from "@expand/desktop/renderer/features/automations/model/run-history"

export interface RunListSelection {
  readonly projectId: string
  readonly limit: number
  readonly outcome: RunOutcomeFilter
  readonly routineId?: string | undefined
}

export interface RunListPage {
  readonly runs: ReadonlyArray<RunRecord>
  readonly page: number
  readonly hasNext: boolean
  readonly hasPrevious: boolean
  readonly error: unknown
  readonly isPending: boolean
  readonly nextPage: () => void
  readonly previousPage: () => void
  readonly refresh: () => void
}

export interface RunDetailsData {
  readonly history: RunHistory | undefined
  readonly routine: RoutineRecord | undefined
  readonly error: unknown
  readonly isPending: boolean
  readonly reload: () => void
}

export const useRunListPage = (selection: RunListSelection): RunListPage => {
  const runner = useRendererRunner()
  const rpc = useOptionalAutomationRpc()
  const [entries, setEntries] = useState<ReadonlyArray<RunListEntry>>([])
  const [position, setPosition] = useState(0)
  const [error, setError] = useState<unknown>(undefined)
  const [isPending, setIsPending] = useState(false)
  const [nonce, setNonce] = useState(0)
  const activeCancelRef = useRef<RendererCancel | undefined>(undefined)
  const invocationRef = useRef(0)
  const mountedRef = useRef(false)
  const rpcRef = useRef(rpc)
  const runnerRef = useRef(runner)

  useEffect(() => {
    rpcRef.current = rpc
    runnerRef.current = runner
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invocationRef.current += 1
      const cancel = activeCancelRef.current
      activeCancelRef.current = undefined
      cancel?.()
    }
  }, [])

  const selectionKey = `${selection.projectId}\n${selection.limit}\n${selection.outcome}\n${selection.routineId ?? ""}`

  useEffect(() => {
    const currentRpc = rpcRef.current
    if (currentRpc === undefined) {
      setEntries([])
      setPosition(0)
      setError(undefined)
      setIsPending(false)
      return
    }
    const invocation = invocationRef.current + 1
    invocationRef.current = invocation
    const previousCancel = activeCancelRef.current
    activeCancelRef.current = undefined
    previousCancel?.()
    setIsPending(true)
    setError(undefined)
    setEntries([])
    setPosition(0)
    let exited = false
    const cancel = runnerRef.current.start(
      runListEffect(currentRpc, selection, undefined),
      (exit) => {
        exited = true
        if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause)
        if (!mountedRef.current || invocationRef.current !== invocation) return
        activeCancelRef.current = undefined
        setIsPending(false)
        if (Exit.isSuccess(exit)) {
          setEntries([{ runs: exit.value.runs, cursor: exit.value.cursor }])
          return
        }
        const failure = Cause.findErrorOption(exit.cause)
        if (Option.isNone(failure)) return
        setError(failure.value)
      }
    )
    if (!exited && mountedRef.current && invocationRef.current === invocation) {
      activeCancelRef.current = cancel
    }
  }, [selectionKey, nonce])

  const appendNext = useCallback(() => {
    const currentRpc = rpcRef.current
    if (currentRpc === undefined || isPending) return
    const current = entries[position]
    if (current === undefined) return
    if (position < entries.length - 1) {
      setPosition(position + 1)
      return
    }
    if (current.cursor === null) return
    const cursor = current.cursor
    const invocation = invocationRef.current + 1
    invocationRef.current = invocation
    const previousCancel = activeCancelRef.current
    activeCancelRef.current = undefined
    previousCancel?.()
    setIsPending(true)
    setError(undefined)
    let exited = false
    const cancel = runnerRef.current.start(
      runListEffect(currentRpc, selection, cursor),
      (exit) => {
        exited = true
        if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause)
        if (!mountedRef.current || invocationRef.current !== invocation) return
        activeCancelRef.current = undefined
        setIsPending(false)
        if (Exit.isSuccess(exit)) {
          setEntries((previous) => [...previous, { runs: exit.value.runs, cursor: exit.value.cursor }])
          setPosition((previous) => previous + 1)
          return
        }
        const failure = Cause.findErrorOption(exit.cause)
        if (Option.isNone(failure)) return
        setError(failure.value)
      }
    )
    if (!exited && mountedRef.current && invocationRef.current === invocation) {
      activeCancelRef.current = cancel
    }
  }, [entries, isPending, position, selection])

  const previousPage = useCallback(() => {
    if (position > 0) setPosition(position - 1)
  }, [position])

  const refresh = useCallback(() => {
    setNonce((current) => current + 1)
  }, [])

  const current = entries[position]
  return {
    runs: current === undefined ? [] : current.runs,
    page: position + 1,
    hasNext: position < entries.length - 1 || (current !== undefined && current.cursor !== null),
    hasPrevious: position > 0,
    error,
    isPending,
    nextPage: appendNext,
    previousPage,
    refresh
  }
}

export const useRunDetails = (projectId: string, runId: string | undefined): RunDetailsData => {
  const runner = useRendererRunner()
  const rpc = useOptionalAutomationRpc()
  const [history, setHistory] = useState<RunHistory | undefined>(undefined)
  const [routine, setRoutine] = useState<RoutineRecord | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [isPending, setIsPending] = useState(false)
  const [nonce, setNonce] = useState(0)
  const activeCancelRef = useRef<RendererCancel | undefined>(undefined)
  const invocationRef = useRef(0)
  const mountedRef = useRef(false)
  const rpcRef = useRef(rpc)
  const runnerRef = useRef(runner)

  useEffect(() => {
    rpcRef.current = rpc
    runnerRef.current = runner
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invocationRef.current += 1
      const cancel = activeCancelRef.current
      activeCancelRef.current = undefined
      cancel?.()
    }
  }, [])

  const requestKey = `${projectId}\n${runId ?? ""}\n${nonce}`

  useEffect(() => {
    const currentRpc = rpcRef.current
    if (currentRpc === undefined || runId === undefined) {
      setHistory(undefined)
      setRoutine(undefined)
      setError(undefined)
      setIsPending(false)
      return
    }
    const invocation = invocationRef.current + 1
    invocationRef.current = invocation
    const previousCancel = activeCancelRef.current
    activeCancelRef.current = undefined
    previousCancel?.()
    setIsPending(true)
    setError(undefined)
    let exited = false
    const cancel = runnerRef.current.start(runDetailsEffect(currentRpc, projectId, runId), (exit) => {
      exited = true
      if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause)
      if (!mountedRef.current || invocationRef.current !== invocation) return
      activeCancelRef.current = undefined
      setIsPending(false)
      if (Exit.isSuccess(exit)) {
        setHistory(exit.value.history)
        setRoutine(exit.value.routine)
        return
      }
      const failure = Cause.findErrorOption(exit.cause)
      if (Option.isNone(failure)) return
      setError(failure.value)
    })
    if (!exited && mountedRef.current && invocationRef.current === invocation) {
      activeCancelRef.current = cancel
    }
  }, [requestKey])

  const reload = useCallback(() => {
    setNonce((current) => current + 1)
  }, [])

  return { history, routine, error, isPending, reload }
}

interface RunListEntry {
  readonly runs: ReadonlyArray<RunRecord>
  readonly cursor: string | null
}

const runListEffect = (rpc: AutomationRpcApi, selection: RunListSelection, cursor: string | undefined) =>
  rpc.listRuns({
    scope: automationScopeForProject(selection.projectId),
    limit: selection.limit,
    ...(cursor === undefined ? {} : { cursor }),
    ...(selection.routineId === undefined ? {} : { routineId: selection.routineId }),
    ...(runStateForFilter(selection.outcome) === undefined
      ? {}
      : { state: runStateForFilter(selection.outcome)! })
  })

const runDetailsEffect = (rpc: AutomationRpcApi, projectId: string, runId: string) =>
  rpc.getRun({ scope: automationScopeForProject(projectId), runId }).pipe(
    Effect.flatMap((history) =>
      rpc.getRoutine({
        scope: automationScopeForProject(projectId),
        routineId: history.run.run.configuration.routineId
      }).pipe(
        Effect.map((routine): { readonly history: RunHistory; readonly routine: RoutineRecord | undefined } => ({
          history,
          routine
        })),
        Effect.orElseSucceed((): { readonly history: RunHistory; readonly routine: RoutineRecord | undefined } => ({
          history,
          routine: undefined
        }))
      )
    )
  )
