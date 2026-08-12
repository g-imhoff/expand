// apps/tui/components/app.tsx
// The only stateful component. One key pipeline:
//   useKeyRouter → route (pure) → uiReduce (pure) → setUi + runEffect.
import React, { useEffect, useReducer, useRef } from "react"
import { Box } from "ink"
import { HintBar, useGlobalKeyRouter } from "@expand/ink-input"
import type { KeyEvent } from "@expand/ink-input"
import { ProjectList } from "@expand/tui/components/project-list"
import { TextField } from "@expand/tui/components/text-field"
import { ConfirmDelete } from "@expand/tui/components/confirm-delete"
import { ErrorLine } from "@expand/tui/components/error-line"
import { useProjects } from "@expand/tui/features/projects/use-projects"
import { initialUiState, assertNever, type Overlay } from "@expand/tui/input/state"
import { activeBindings } from "@expand/tui/input/bindings"
import { route } from "@expand/tui/input/route"
import { uiReduce, type DomainEffect } from "@expand/tui/input/reduce"
import type { Project } from "@expand/contracts/project"

export type QueuedEffect = { readonly id: number; readonly effect: DomainEffect }
export type AppState = { readonly ui: typeof initialUiState; readonly effects: ReadonlyArray<QueuedEffect>; readonly nextId: number }
export type AppAction =
  | { readonly _tag: "Key"; readonly event: KeyEvent; readonly projects: ReadonlyArray<Project> }
  | { readonly _tag: "Reconcile"; readonly projects: ReadonlyArray<Project> }
  | { readonly _tag: "Acknowledge"; readonly ids: ReadonlyArray<number> }
export { App }
const initialAppState: AppState = { ui: initialUiState, effects: [], nextId: 0 }
const appReduce = (state: AppState, action: AppAction): AppState => {
  if (action._tag === "Acknowledge") return { ...state, effects: state.effects.filter((item) => !action.ids.includes(item.id)) }
  const resolved = action._tag === "Key" ? route(state.ui, action.projects, action.event) : { _tag: "Reconcile", projects: action.projects } as const
  if (resolved === null) return state
  const result = uiReduce(state.ui, resolved)
  const effects = result.effects.map((effect, index) => ({ id: state.nextId + index, effect }))
  return { ui: result.ui, effects: [...state.effects, ...effects], nextId: state.nextId + effects.length }
}

const App = () => {

  const {
    projects, error, create, rename, changeDirectory,
    archive, restore, setMetadata, deleteProject
  } = useProjects()
  const [state, dispatch] = useReducer(appReduce, initialAppState)
  const processedEffects = useRef(new Set<number>())

  const runEffect = (effect: DomainEffect): void => {
    switch (effect._tag) {
      case "Create": return create(effect.name)
      case "Rename": return rename(effect.id, effect.name)
      case "ChangeDirectory": return changeDirectory(effect.id, effect.directory)
      case "SetMetadata": return setMetadata(effect.id, { description: effect.description, tags: effect.tags })
      case "Archive": return archive(effect.id)
      case "Restore": return restore(effect.id)
      case "Delete": return deleteProject(effect.id)
      default: return assertNever(effect)
    }
  }

  useGlobalKeyRouter((event: KeyEvent) => {
    dispatch({ _tag: "Key", event, projects })
  })

  useEffect(() => {
    const effects = state.effects.filter((item) => !processedEffects.current.has(item.id))
    for (const item of effects) {
      processedEffects.current.add(item.id)
      runEffect(item.effect)
    }
    if (effects.length > 0) dispatch({ _tag: "Acknowledge", ids: effects.map((item) => item.id) })
    const live = new Set(state.effects.map((item) => item.id))
    for (const id of processedEffects.current) if (!live.has(id)) processedEffects.current.delete(id)
  }, [state.effects, projects])

  useEffect(() => {
    dispatch({ _tag: "Reconcile", projects })
  }, [projects])

  const overlayView = (overlay: Overlay) => {
    switch (overlay.kind) {
      case "rename":
        return <TextField label="rename ▸ " color="yellow" state={overlay.field} focused={true} />
      case "directory":
        return <TextField label="directory ▸ " color="blue" state={overlay.field} focused={true} />
      case "metadata":
        return (
          <Box flexDirection="column">
            <TextField label="description ▸ " color="cyan" state={overlay.description} focused={overlay.active === "description"} />
            <TextField label="tags (a, b) ▸ " color="cyan" state={overlay.tags} focused={overlay.active === "tags"} />
          </Box>
        )
      case "confirmDelete":
        return <ConfirmDelete projectName={projects.find((p) => p.id === overlay.projectId)?.name ?? ""} />
      default:
        return assertNever(overlay)
    }
  }

  return (
    <Box flexDirection="column" gap={1}>
      <ProjectList
        projects={projects}
        selectedId={state.ui.selectedId ?? undefined}
        focused={state.ui.overlay === null && state.ui.focus === "list"}
      />
      <ErrorLine message={error} />
      {state.ui.overlay !== null
        ? overlayView(state.ui.overlay)
        : <TextField label="new project ▸ " state={state.ui.create} focused={state.ui.focus === "create"} />}
      <HintBar bindings={activeBindings(state.ui)} />
    </Box>
  )
}
