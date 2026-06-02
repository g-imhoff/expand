import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PROJECTS_KEY } from "@yodea/desktop/renderer/features/projects/cache"
import { useRpc } from "@yodea/desktop/renderer/rpc/runtime"

// Read the project list. staleTime Infinity: the Events stream keeps the cache
// fresh (folded via applyEventToCache at the root), so no refetch poll is needed.
export const useProjects = () => {
  const { runtime, client } = useRpc()
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => runtime.runPromise(client.ProjectList({})),
    staleTime: Infinity
  })
}

// Create a project. The resulting ProjectCreated arrives via the Events stream and
// folds into the cache, so no manual setQueryData here.
export const useCreateProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => runtime.runPromise(client.ProjectCreate({ name, ensure: true })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

// Rename a project. The resulting ProjectRenamed arrives via the Events stream and
// folds into the cache; invalidate as a belt-and-braces refresh.
export const useRenameProject = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      runtime.runPromise(client.ProjectRename({ id, name })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}

// Change a project's directory. The resulting ProjectDirectoryChanged arrives via
// the Events stream and folds into the cache; invalidate as a belt-and-braces
// refresh. The typed ProjectDirectoryInvalid/Conflict errors reject the promise.
export const useChangeDirectory = () => {
  const { runtime, client } = useRpc()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, directory }: { id: string; directory: string }) =>
      runtime.runPromise(client.ProjectChangeDirectory({ id, directory })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROJECTS_KEY }) }
  })
}
