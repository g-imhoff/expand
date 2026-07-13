import { useCallback, useRef, useState } from "react"
import { Effect } from "effect"
import type { Project } from "@expand/contracts/project"
import { useProjectRpc, useProjectSelector } from "@expand/desktop/renderer/features/projects/data/project-context"

export interface MutationState<I, A> {
  readonly mutate: (input: I, options?: MutationOptions<A>) => void
  readonly mutateAsync: (input: I) => Promise<A>
  readonly error: unknown
  readonly isPending: boolean
  readonly reset: () => void
}

export const useRunMutation = <I, A>(run: (input: I) => Promise<A>): MutationState<I, A> => {
  const [error, setError] = useState<unknown>(undefined)
  const [isPending, setIsPending] = useState(false)
  const runRef = useRef(run)
  runRef.current = run

  const mutateAsync = useCallback((input: I): Promise<A> => {
    setIsPending(true)
    setError(undefined)
    return runRef.current(input).then(
      (result) => { setIsPending(false); return result },
      (cause: unknown) => { setIsPending(false); setError(cause); throw cause }
    )
  }, [])

  const mutate = useCallback((input: I, options?: MutationOptions<A>) => {
    mutateAsync(input).then(
      (result) => options?.onSuccess?.(result),
      (cause: unknown) => options?.onError?.(cause)
    )
  }, [mutateAsync])

  const reset = useCallback(() => { setError(undefined); setIsPending(false) }, [])

  return { mutate, mutateAsync, error, isPending, reset }
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
    Effect.runPromise(
      rpc.create({ name, ensure: true }).pipe(
        Effect.catchTag("ProjectAlreadyExists", (error) => Effect.die(error)),
        Effect.map((result) => result.project)
      )
    ))
}

export const useRenameProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((args: { id: string; name: string }) => Effect.runPromise(rpc.rename(args)))
}

export const useChangeDirectory = () => {
  const rpc = useProjectRpc()
  return useRunMutation((args: { id: string; directory: string }) => Effect.runPromise(rpc.changeDirectory(args)))
}

export const useArchiveProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((id: string) => Effect.runPromise(rpc.archive({ id })))
}

export const useRestoreProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((id: string) => Effect.runPromise(rpc.restore({ id })))
}

export const useSetMetadata = () => {
  const rpc = useProjectRpc()
  return useRunMutation((args: { id: string; description?: string | null; tags?: ReadonlyArray<string> }) =>
    Effect.runPromise(
      rpc.setMetadata({
        id: args.id,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {})
      })
    ))
}

export const useDeleteProject = () => {
  const rpc = useProjectRpc()
  return useRunMutation((id: string) => Effect.runPromise(rpc.delete({ id })))
}

interface MutationOptions<A> {
  readonly onSuccess?: (result: A) => void
  readonly onError?: (error: unknown) => void
}
