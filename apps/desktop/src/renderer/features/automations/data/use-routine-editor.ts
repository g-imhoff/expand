import { useCallback, useEffect, useRef, useState } from "react"
import { Cause, Data, Effect, Exit, Option } from "effect"
import type { Catalog } from "@expand/contracts/automation"
import type { PreviewOutcome, RoutineHead, RoutineRecord } from "@expand/contracts/rpc/automation-schemas"
import { useRendererRunner } from "@expand/desktop/renderer/app/runner-context"
import { useAutomationRpc } from "@expand/desktop/renderer/features/automations/data/automation-context"
import { automationScope } from "@expand/desktop/renderer/features/automations/data/automation-scope"
import { previewDecision } from "@expand/desktop/renderer/features/automations/model/routine-editor"
import type { RoutineWrite } from "@expand/desktop/renderer/features/automations/model/routine-editor"
import { useRunMutation, type MutationState } from "@expand/desktop/renderer/features/projects/data/use-projects"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"

export interface CatalogState {
  readonly catalog: Catalog | undefined
  readonly error: unknown
  readonly isLoading: boolean
  readonly unavailable: boolean
  readonly retry: () => void
}

export interface RoutineRecordState {
  readonly record: RoutineRecord | undefined
  readonly error: unknown
  readonly isLoading: boolean
  readonly unavailable: boolean
  readonly reload: () => void
}

export interface RoutineSaveInput {
  readonly routineId: string
  readonly mode: "create" | "edit"
  readonly write: RoutineWrite
}

export interface RoutineStatusInput {
  readonly routineId: string
  readonly expectedVersion: number
  readonly next: "enabled" | "paused"
}

export interface RoutinePreviewInput {
  readonly inlineRoutineId: string
  readonly write: RoutineWrite
  readonly issueNumber: number
  readonly title: string
  readonly body: string | undefined
  readonly outcomeId: string | undefined
  readonly abstainReason: string
}

export class AutomationUnavailable extends Data.TaggedError("AutomationUnavailable")<{
  readonly message: string
}> {}

export const useAutomationCatalog = (): CatalogState => {
  const query = useAutomationQuery((api) => api.catalog(), "catalog")
  return {
    catalog: query.data,
    error: query.error,
    isLoading: query.isLoading,
    unavailable: query.unavailable,
    retry: query.retry
  }
}

export const useRoutineRecord = (projectId: string, routineId: string | undefined): RoutineRecordState => {
  const query = useAutomationQuery(
    (api) => api.getRoutine({ scope: automationScope(projectId), routineId: routineId ?? "" }),
    `${projectId}/${routineId ?? ""}`,
    routineId === undefined
  )
  return {
    record: query.data,
    error: query.error,
    isLoading: query.isLoading,
    unavailable: query.unavailable,
    reload: query.reload
  }
}

export const useRoutineSave = (
  projectId: string
): MutationState<RoutineSaveInput, { readonly revision: number }, unknown> => {
  const rpc = useAutomationRpc()
  return useRunMutation((input: RoutineSaveInput): Effect.Effect<{ readonly revision: number }, unknown> => {
    if (rpc === null) return Effect.fail(new AutomationUnavailable({ message: unavailableMessage }))
    const scope = automationScope(projectId)
    return input.mode === "create"
      ? rpc.createRoutine({ scope, routineId: input.routineId, ...input.write })
      : rpc.editRoutine({ scope, routineId: input.routineId, ...input.write })
  })
}

export const useRoutineStatus = (
  projectId: string
): MutationState<RoutineStatusInput, RoutineHead, unknown> => {
  const rpc = useAutomationRpc()
  return useRunMutation((input: RoutineStatusInput): Effect.Effect<RoutineHead, unknown> => {
    if (rpc === null) return Effect.fail(new AutomationUnavailable({ message: unavailableMessage }))
    const scope = automationScope(projectId)
    return input.next === "enabled"
      ? rpc.enableRoutine({ scope, routineId: input.routineId, expectedVersion: input.expectedVersion })
      : rpc.pauseRoutine({ scope, routineId: input.routineId, expectedVersion: input.expectedVersion })
  })
}

export const useRoutinePreview = (
  projectId: string
): MutationState<RoutinePreviewInput, PreviewOutcome, unknown> => {
  const rpc = useAutomationRpc()
  return useRunMutation((input: RoutinePreviewInput): Effect.Effect<PreviewOutcome, unknown> => {
    if (rpc === null) return Effect.fail(new AutomationUnavailable({ message: unavailableMessage }))
    return rpc.preview({
      scope: automationScope(projectId),
      inline: { routineId: input.inlineRoutineId, ...input.write },
      issue: {
        issueNumber: input.issueNumber,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body })
      },
      decision: previewDecision(input.outcomeId, input.abstainReason)
    })
  })
}

interface AutomationQuery<A> {
  readonly data: A | undefined
  readonly error: unknown
  readonly isLoading: boolean
  readonly retry: () => void
  readonly reload: () => void
  readonly unavailable: boolean
}

const unavailableMessage = "Automation services are unavailable in this session."

const useAutomationQuery = <A,>(
  run: (api: AutomationRpcApi) => Effect.Effect<A, unknown>,
  reloadKey: string,
  skip = false
): AutomationQuery<A> => {
  const runner = useRendererRunner()
  const rpc = useAutomationRpc()
  const [data, setData] = useState<A | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const runRef = useRef(run)

  useEffect(() => {
    runRef.current = run
  })

  useEffect(() => {
    if (rpc === null || skip) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(undefined)
    let cancelled = false
    const cancel = runner.start(runRef.current(rpc), (exit) => {
      if (cancelled) return
      if (Exit.isSuccess(exit)) {
        setData(exit.value)
        setError(undefined)
        setIsLoading(false)
        return
      }
      if (Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause)
      const failure = Cause.findErrorOption(exit.cause)
      if (Option.isNone(failure)) return
      setError(failure.value)
      setIsLoading(false)
    })
    return () => {
      cancelled = true
      cancel()
    }
  }, [runner, rpc, attempt, reloadKey, skip])

  const retry = useCallback(() => {
    setAttempt((count) => count + 1)
  }, [])

  return { data, error, isLoading, retry, reload: retry, unavailable: rpc === null }
}
