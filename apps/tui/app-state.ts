export type Screen =
  | { readonly kind: "projectList" }
  | { readonly kind: "projectWorkspace"; readonly projectId: string }

export interface AppState {
  readonly screen: Screen
  readonly transientError?: string
  readonly notice?: string
}

export type AppAction =
  | { readonly type: "navigate"; readonly screen: Screen }
  | { readonly type: "setError"; readonly message: string }
  | { readonly type: "setNotice"; readonly message: string }
  | { readonly type: "clearTransients" }

export const initialAppState: AppState = { screen: { kind: "projectList" } }

// Each case returns a fresh object that OMITS transients unless explicitly set
// (exactOptionalPropertyTypes: never assign `undefined`).
export const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case "navigate":
      return { screen: action.screen }
    case "setError":
      return { screen: state.screen, transientError: action.message }
    case "setNotice":
      return { screen: state.screen, notice: action.message }
    case "clearTransients":
      return { screen: state.screen }
  }
}
