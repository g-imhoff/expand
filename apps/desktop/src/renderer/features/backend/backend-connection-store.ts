import { createStore, type StoreApi } from "zustand/vanilla"
import { Schema } from "effect"

export interface BackendConnectionState {
  readonly mode: BackendMode
  readonly remoteHost: string
  readonly remotePort: number | undefined
  readonly remoteUrl: string
  readonly secure: boolean
  readonly selectedProjectId: string | undefined
  readonly lastSeq: number
  readonly status: BackendConnectionStatus
  readonly error: string | undefined
}

export type BackendMode = "local" | "remote"

export type BackendConnectionStatus = "connected" | "reconnecting" | "disconnected" | "error"

export type BackendConnectionStore = StoreApi<BackendConnectionState>

export const makeBackendConnectionStore = (
  initial?: Partial<BackendConnectionState>
): BackendConnectionStore =>
  createStore<BackendConnectionState>()(() => ({
    mode: "local",
    remoteHost: "",
    remotePort: undefined,
    remoteUrl: "",
    secure: false,
    selectedProjectId: undefined,
    lastSeq: 0,
    status: "disconnected",
    error: undefined,
    ...initial
  }))

export const switchBackendMode = (
  store: BackendConnectionStore,
  mode: BackendMode
): void => {
  store.setState({ mode, status: "disconnected", error: undefined })
}

export const rememberSelectedProject = (
  store: BackendConnectionStore,
  projectId: string | undefined
): void => {
  store.setState({ selectedProjectId: projectId })
}

export const noteBackendSnapshot = (
  store: BackendConnectionStore,
  seq: number
): void => {
  store.setState({ lastSeq: seq, status: "connected", error: undefined })
}

export const reportBackendStatus = (
  store: BackendConnectionStore,
  status: BackendConnectionStatus,
  error?: string | undefined
): void => {
  store.setState(error === undefined ? { status } : { status, error })
}

export const saveBackendConnection = (
  store: BackendConnectionStore,
  storage: Pick<Storage, "setItem"> | undefined
): void => {
  if (storage === undefined) return
  const state = store.getState()
  const json = Schema.encodeSync(BackendConnectionPersistedJson)({
    mode: state.mode,
    remoteHost: state.remoteHost,
    remotePort: state.remotePort,
    remoteUrl: state.remoteUrl,
    secure: state.secure,
    selectedProjectId: state.selectedProjectId,
    lastSeq: state.lastSeq
  })
  storage.setItem(backendConnectionStorageKey, json)
}

export const loadBackendConnection = (
  storage: Pick<Storage, "getItem"> | undefined
): Partial<BackendConnectionState> | undefined => {
  if (storage === undefined) return undefined
  const raw = storage.getItem(backendConnectionStorageKey)
  if (raw === null) return undefined
  try {
    return Schema.decodeUnknownSync(BackendConnectionPersistedJson)(raw)
  } catch {
    return undefined
  }
}

export const backendConnectionStorageKey = "expand.backend-connection.v1"

const BackendConnectionPersistedJson = Schema.fromJsonString(Schema.Struct({
  mode: Schema.Literals(["local", "remote"]),
  remoteHost: Schema.String,
  remotePort: Schema.optional(Schema.Number),
  remoteUrl: Schema.String,
  secure: Schema.Boolean,
  selectedProjectId: Schema.optional(Schema.String),
  lastSeq: Schema.Number
}))
