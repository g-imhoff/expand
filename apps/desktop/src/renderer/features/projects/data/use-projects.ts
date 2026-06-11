import { useCallback, useRef, useState, useSyncExternalStore } from "react"
import type { Project, ProjectId } from "@yodea/contracts/project"
import { useAppHandle } from "@yodea/desktop/renderer/app/AppHandleProvider"

interface MutationOptions<A> {
  readonly onSuccess?: (result: A) => void
  readonly onError?: (error: unknown) => void
}

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

const useProjectsSnapshot = (): ReadonlyArray<Project> => {
  const handle = useAppHandle()
  return useSyncExternalStore(handle.subscribe, handle.getProjects, handle.getProjects)
}

export const useProjects = (): { data: ReadonlyArray<Project>; error: unknown } => ({
  data: useProjectsSnapshot(),
  error: undefined
})

export const useAllProjects = (): { data: ReadonlyArray<Project> } => ({
  data: useProjectsSnapshot()
})

export const useCreateProject = () => {
  const handle = useAppHandle()
  return useRunMutation((name: string) => handle.createProject(name))
}

export const useRenameProject = () => {
  const handle = useAppHandle()
  return useRunMutation((args: { id: ProjectId; name: string }) => handle.renameProject(args))
}

export const useChangeDirectory = () => {
  const handle = useAppHandle()
  return useRunMutation((args: { id: ProjectId; directory: string }) => handle.changeDirectory(args))
}

export const useArchiveProject = () => {
  const handle = useAppHandle()
  return useRunMutation((id: ProjectId) => handle.archiveProject(id))
}

export const useRestoreProject = () => {
  const handle = useAppHandle()
  return useRunMutation((id: ProjectId) => handle.restoreProject(id))
}

export const useSetMetadata = () => {
  const handle = useAppHandle()
  return useRunMutation((args: { id: ProjectId; description?: string | null; tags?: ReadonlyArray<string> }) =>
    handle.setMetadata(args))
}

export const useDeleteProject = () => {
  const handle = useAppHandle()
  return useRunMutation((id: ProjectId) => handle.deleteProject(id))
}
