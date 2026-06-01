import { useContext, useReducer, useRef } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { Cause, Effect, Exit } from "effect"
import { ProjectStore } from "@yodea/client-core"
import { RuntimeContext } from "@yodea/tui/runtime"
import { appReducer, initialAppState } from "@yodea/tui/app-state"
import { useProjects } from "@yodea/tui/hooks/use-projects"
import { parseInput } from "@yodea/tui/commands/parse"
import { dispatch as dispatchCommand } from "@yodea/tui/commands/registry"
import type { CommandContext } from "@yodea/tui/commands/types"
import { StatusLine } from "@yodea/tui/components/status-line"
import { ProjectList } from "@yodea/tui/components/project-list"
import { ProjectWorkspaceView } from "@yodea/tui/components/project-workspace-view"
import { Composer } from "@yodea/tui/components/composer"
import { ErrorView } from "@yodea/tui/components/error-view"

export const App = () => {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("App must be used within a RuntimeContext")
  const { exit } = useApp()
  const [appState, dispatch] = useReducer(appReducer, initialAppState)
  const projects = useProjects()
  const cancelRef = useRef<(() => void) | null>(null)

  const list = projects.status === "ready" ? projects.projects : []

  const create = (name: string) => {
    cancelRef.current = runtime.runCallback(
      Effect.flatMap(ProjectStore, (s) => s.createProject(name)),
      {
        onExit: (createExit) => {
          if (Exit.isFailure(createExit)) {
            dispatch({ type: "setError", message: Cause.pretty(createExit.cause) })
          }
        },
      }
    )
  }

  const ctx: CommandContext = {
    navigate: (screen) => dispatch({ type: "navigate", screen }),
    projects: { list, create },
    setError: (message) => dispatch({ type: "setError", message }),
    setNotice: (message) => dispatch({ type: "setNotice", message }),
    exit: () => exit(),
    submitMessage: (text) =>
      dispatch({ type: "setNotice", message: `Chat is coming soon — "${text}" not sent. Try /help.` }),
  }

  const onSubmit = (line: string) => {
    dispatch({ type: "clearTransients" })
    const parsed = parseInput(line)
    if (parsed.kind === "empty") return
    if (parsed.kind === "command") {
      dispatchCommand(parsed.name, parsed.args, ctx)
      return
    }
    ctx.submitMessage(parsed.text)
  }

  // Global keybinds. The Composer ignores ctrl/meta combos, so these never
  // collide with text entry. Ctrl-C exit is left to Ink's default exitOnCtrlC.
  useInput((input, key) => {
    if (key.escape) {
      cancelRef.current?.()
      return
    }
    if (key.ctrl && input === "p") {
      if (list.length === 0) return
      const currentId = appState.screen.kind === "projectWorkspace" ? appState.screen.projectId : undefined
      const idx = list.findIndex((p) => p.id === currentId)
      const next = list[(idx + 1) % list.length] ?? list[0]
      if (next) dispatch({ type: "navigate", screen: { kind: "projectWorkspace", projectId: next.id } })
      return
    }
    if (key.ctrl && input === "d") exit()
  })

  if (projects.status === "error") {
    return <ErrorView message={projects.message} />
  }

  const activeScreen = appState.screen
  const activeProject =
    activeScreen.kind === "projectWorkspace"
      ? list.find((p) => p.id === activeScreen.projectId)
      : undefined

  return (
    <Box flexDirection="column" gap={1}>
      <StatusLine
        screen={appState.screen}
        projectName={activeProject?.name}
        transientError={appState.transientError}
        notice={appState.notice}
      />
      {appState.screen.kind === "projectList" ? (
        projects.status === "loading" ? (
          <Text dimColor>Connecting to backend…</Text>
        ) : (
          <ProjectList projects={list} />
        )
      ) : (
        <ProjectWorkspaceView project={activeProject} />
      )}
      <Composer isActive onSubmit={onSubmit} />
    </Box>
  )
}
