import { useCallback, useEffect, useRef, useState } from "react"
import { Cause, Effect, Exit, Option } from "effect"
import type { Project } from "@expand/contracts/project"
import type { RendererCancel, RendererRunner } from "@expand/desktop/renderer/app/runner"
import { useRendererRunner } from "@expand/desktop/renderer/app/runner-context"
import { useProjectRpc, useProjectSelector } from "@expand/desktop/renderer/features/projects/data/project-context"

export interface MutationState<I, A, E> {
  readonly mutate: (input: I, options?: MutationOptions<A, E>) => void
  readonly error: E | undefined
  readonly isPending: boolean
  readonly reset: () => void
}

export const useRunMutation = <I, A, E>(
  run: (input: I) => Effect.Effect<A, E>
): MutationState<I, A, E> => {
  const runner = useRendererRunner()
  return useOwnedMutation(runner, run)
}

export const useProjects = (): { data: ReadonlyArray<Project>; error: unknown } => ({
  data: useProjectSelector((state) => state.projects),
  error: undefined
})

export const useAllProjects = (): { data: ReadonlyArray<Project> } => ({
  data: useProjectSelector((state) => state.projects)
})

export const useCreateProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((name: string) =>
    rpc.create({ name, ensure: true }).pipe(
      Effect.map((result) => result.project)
    ))
}

export const useRenameProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((args: { id: string; name: string }) => rpc.rename(args))
}

export const useChangeDirectory = () => {
  const rpc = useProjectRpc()
  return useRunMutation((args: { id: string; directory: string }) => rpc.changeDirectory(args))
}

export const useArchiveProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((id: string) => rpc.archive({ id }))
}

export const useRestoreProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((id: string) => rpc.restore({ id }))
}

export const useSetMetadata = () => {
  const rpc = useProjectRpc()
  return useRunMutation((args: { id: string; description?: string | null; tags?: ReadonlyArray<string> }) =>
    rpc.setMetadata({
      id: args.id,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {})
    }))
}

export const useDeleteProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((id: string) => rpc.delete({ id }))
}

interface MutationOptions<A, E> {
  readonly onSuccess?: (result: A) => void
  readonly onError?: (error: E) => void
}

const useOwnedMutation = <I, A, E>(
  runner: RendererRunner,
  run: (input: I) => Effect.Effect<A, E>
): MutationState<I, A, E> => {
  const [error, setError] = useState<E | undefined>(undefined)
  const [isPending, setIsPending] = useState(false)
  const activeCancelRef = useRef<RendererCancel | undefined>(undefined)
  const invocationRef = useRef(0)
  const mountedRef = useRef(false)
  const runRef = useRef(run)

  useEffect(() => {
    runRef.current = run
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
  }, [runner])

  const mutate = useCallback((input: I, options?: MutationOptions<A, E>) => {
    const invocation = invocationRef.current + 1
    invocationRef.current = invocation
    const previousCancel = activeCancelRef.current
    activeCancelRef.current = undefined
    previousCancel?.()
    setIsPending(true)
    setError(undefined)
    let exited = false
    const cancel = runner.start(runRef.current(input), (exit) => {
      exited = true
      if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) throw Cause.squash(exit.cause)
      if (!mountedRef.current || invocationRef.current !== invocation) return
      activeCancelRef.current = undefined
      setIsPending(false)
      if (Exit.isSuccess(exit)) {
        options?.onSuccess?.(exit.value)
        return
      }
      const failure = Cause.findErrorOption(exit.cause)
      if (Option.isNone(failure)) return
      setError(failure.value)
      options?.onError?.(failure.value)
    })
    if (!exited && mountedRef.current && invocationRef.current === invocation) {
      activeCancelRef.current = cancel
    }
  }, [runner])

  const reset = useCallback(() => { setError(undefined); setIsPending(false) }, [])

  return { mutate, error, isPending, reset }
}
