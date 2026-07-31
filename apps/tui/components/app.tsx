// apps/tui/components/app.tsx
// The only stateful component. One key pipeline:
//   useKeyRouter → route (pure) → uiReduce (pure) → setUi + runEffect.
import React, { useEffect, useState } from "react"
import { Box } from "ink"
import { useKeyRouter } from "@expand/ink-input/use-key-router-ink"
import { HintBar } from "@expand/ink-input/components/hint-bar-ink"
import { ProjectList } from "@expand/tui/components/project-list"
import { TextField } from "@expand/tui/components/text-field"
import { ConfirmDelete } from "@expand/tui/components/confirm-delete"
import { ErrorLine } from "@expand/tui/components/error-line"
import { useProjects } from "@expand/tui/features/projects/use-projects"
import { initialUiState, assertNever, type Overlay } from "@expand/tui/input/state"
import { activeBindings } from "@expand/tui/input/bindings"
import { route } from "@expand/tui/input/route"
import { uiReduce, type DomainEffect } from "@expand/tui/input/reduce"

export const App = () => {
  const {
    projects, error, create, rename, changeDirectory,
    archive, restore, setMetadata, deleteProject
  } = useProjects()
  const [ui, setUi] = useState(initialUiState)

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

  useKeyRouter((keyName, input) => {
    const action = route(ui, projects, keyName, input)
    if (action === null) return
    const result = uiReduce(ui, action)
    setUi(result.ui)
    for (const effect of result.effects) runEffect(effect)
  })

  useEffect(() => {
    setUi((current) => uiReduce(current, { _tag: "Reconcile", projects }).ui)
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
        selectedId={ui.selectedId ?? undefined}
        focused={ui.overlay === null && ui.focus === "list"}
      />
      <ErrorLine message={error} />
      {ui.overlay !== null
        ? overlayView(ui.overlay)
        : <TextField label="new project ▸ " state={ui.create} focused={ui.focus === "create"} />}
      <HintBar bindings={activeBindings(ui)} />
    </Box>
  )
}
