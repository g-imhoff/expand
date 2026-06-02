import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ALL_PROJECTS_KEY, PROJECTS_KEY } from "@yodea/desktop/renderer/features/projects/cache"
import { useRpc } from "@yodea/desktop/renderer/rpc/runtime"

export const useProjects = () => {
  const { runtime, client } = useRpc()
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => runtime.runPromise(client.ProjectList({})),
    staleTime: Infinity
  })
}

export const useAllProjects = () => {
  const { runtime, client } = useRpc()
  return useQuery({
    queryKey: ALL_PROJECTS_KEY,
    queryFn: () => runtime.runPromise(client.ProjectList({ includeArchived: true })),
    staleTime: Infinity
  })
}

export const useCreateProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => runtime.runPromise(client.ProjectCreate({ name, ensure: true })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

export const useRenameProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      runtime.runPromise(client.ProjectRename({ id, name })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

export const useChangeDirectory = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, directory }: { id: string; directory: string }) =>
      runtime.runPromise(client.ProjectChangeDirectory({ id, directory })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

export const useArchiveProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => runtime.runPromise(client.ProjectArchive({ id })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

export const useRestoreProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => runtime.runPromise(client.ProjectRestore({ id })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

export const useSetMetadata = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; description?: string | null; tags?: ReadonlyArray<string> }) =>
      runtime.runPromise(client.ProjectSetMetadata(args)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

export const useDeleteProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => runtime.runPromise(client.ProjectDelete({ id })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}
