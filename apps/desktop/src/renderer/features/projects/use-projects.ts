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
