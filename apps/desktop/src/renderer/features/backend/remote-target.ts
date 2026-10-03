export interface RemoteFormInput {
  readonly host: string
  readonly portText: string
  readonly url: string
  readonly secure: boolean
  readonly token: string
}

export interface RemoteProbeView {
  readonly reachable: boolean
  readonly authenticated: boolean
  readonly detail: string
}

export type RemoteFormError =
  | { readonly _tag: "TokenRequired" }
  | { readonly _tag: "TargetRequired" }
  | { readonly _tag: "InvalidPort" }
  | { readonly _tag: "InvalidUrl" }
  | { readonly _tag: "ForbiddenCredentials" }

export const parsePortText = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (!/^[0-9]+$/.test(trimmed)) return undefined
  const port = Number.parseInt(trimmed, 10)
  return port >= 1 && port <= 65535 ? port : undefined
}

export const validateRemoteForm = (input: RemoteFormInput): RemoteFormError | undefined => {
  if (input.token.trim().length === 0) return { _tag: "TokenRequired" }
  if (input.url.trim().length > 0) {
    let parsed: URL
    try {
      parsed = new URL(input.url.trim())
    } catch {
      return { _tag: "InvalidUrl" }
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return { _tag: "InvalidUrl" }
    if (parsed.username.length > 0 || parsed.password.length > 0) return { _tag: "ForbiddenCredentials" }
    if (parsed.hostname.length === 0) return { _tag: "InvalidUrl" }
    return undefined
  }
  if (input.host.trim().length === 0) return { _tag: "TargetRequired" }
  if (parsePortText(input.portText) === undefined) return { _tag: "InvalidPort" }
  return undefined
}

export const describeRemoteFormError = (error: RemoteFormError): string => {
  switch (error._tag) {
  case "TokenRequired":
    return "Enter the backend token."
  case "TargetRequired":
    return "Enter a host and port, or a full backend URL."
  case "InvalidPort":
    return "Port must be a number between 1 and 65535."
  case "InvalidUrl":
    return "URL must look like ws://host:port/rpc or wss://host:port/rpc."
  case "ForbiddenCredentials":
    return "Keep the token in its own field; the URL must not embed credentials."
  }
}

export const describeRemoteProbe = (probe: RemoteProbeView): string => {
  if (probe.reachable && probe.authenticated) return `Connected. ${probe.detail}`
  if (probe.reachable) return `Reachable, but the token was rejected. ${probe.detail}`
  return `Unreachable. ${probe.detail}`
}

export const formatRemoteFlag = (value: boolean): string => value ? "yes" : "no"
