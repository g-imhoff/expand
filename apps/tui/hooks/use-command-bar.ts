import { useReducer } from "react"
import { suggestionsFor } from "@yodea/tui/commands/registry"
import type { SlashCommand } from "@yodea/tui/commands/types"

export interface CommandBarState {
  readonly buffer: string
  readonly history: ReadonlyArray<string>
  readonly historyIndex: number // -1 = not browsing history
  readonly suggestions: ReadonlyArray<SlashCommand>
}

export type CommandBarAction =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "newline" }
  | { readonly type: "historyPrev" }
  | { readonly type: "historyNext" }
  | { readonly type: "reset" }
  | { readonly type: "commit" }

export const initialCommandBarState: CommandBarState = {
  buffer: "",
  history: [],
  historyIndex: -1,
  suggestions: [],
}

const withBuffer = (state: CommandBarState, buffer: string): CommandBarState => ({
  ...state,
  buffer,
  historyIndex: -1,
  suggestions: suggestionsFor(buffer),
})

export const commandBarReducer = (state: CommandBarState, action: CommandBarAction): CommandBarState => {
  switch (action.type) {
    case "insert":
      return withBuffer(state, state.buffer + action.text)
    case "backspace":
      return withBuffer(state, state.buffer.slice(0, -1))
    case "newline":
      return withBuffer(state, state.buffer + "\n")
    case "historyPrev": {
      if (state.history.length === 0) return state
      const nextIndex =
        state.historyIndex === -1 ? state.history.length - 1 : Math.max(0, state.historyIndex - 1)
      const recalled = state.history[nextIndex] ?? ""
      return { ...state, buffer: recalled, historyIndex: nextIndex, suggestions: suggestionsFor(recalled) }
    }
    case "historyNext": {
      if (state.historyIndex === -1) return state
      const nextIndex = state.historyIndex + 1
      if (nextIndex >= state.history.length) {
        return { ...state, buffer: "", historyIndex: -1, suggestions: [] }
      }
      const recalled = state.history[nextIndex] ?? ""
      return { ...state, buffer: recalled, historyIndex: nextIndex, suggestions: suggestionsFor(recalled) }
    }
    case "reset":
      return { ...state, buffer: "", historyIndex: -1, suggestions: [] }
    case "commit": {
      const entry = state.buffer.trim()
      const history = entry.length > 0 ? [...state.history, entry] : state.history
      return { ...state, buffer: "", history, historyIndex: -1, suggestions: [] }
    }
  }
}

export const useCommandBar = () => useReducer(commandBarReducer, initialCommandBarState)
