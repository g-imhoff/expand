// Main interpreter: the authoritative trust boundary. Pure module — MUST NOT
// import "electron"; the adapter in main-electron.ts narrows real Electron
// objects to the structural interfaces below (same idiom as MainPortLike).
//
// Security pipeline (spec §7.2), in order, for EVERY kind including send:
//   1. snapshotSender (synchronous — frames may detach after any await)
//   2. validateSender (parsed-URL exact origin match; main frame only)
//   3. payload size guard
//   4. Schema decode (failure: drop for send/portExchange, defect envelope for invoke)
//   5. typed handler dispatch

export type OriginRule =
  | { readonly _tag: "exactOrigin"; readonly origin: string }
  | { readonly _tag: "fileProtocol" }

export interface FrameLike {
  readonly url: string
  readonly detached: boolean
}

export interface IpcMainEventLike {
  readonly sender: unknown
  readonly senderFrame: FrameLike | null
}

export interface WindowTargetLike {
  readonly webContents: unknown
  readonly mainFrame: FrameLike | null
  readonly postToRenderer: (channel: string, payload: unknown, transfer: ReadonlyArray<unknown>) => void
}

export interface FrameSnapshot {
  readonly url: string | null
  readonly isMainFrame: boolean
}

/** Synchronous sender snapshot. MUST be called before any await/yield. */
export const snapshotSender = (event: IpcMainEventLike, target: WindowTargetLike): FrameSnapshot => {
  if (event.sender !== target.webContents) return { url: null, isMainFrame: false }
  const frame = event.senderFrame
  if (frame === null || frame.detached) return { url: null, isMainFrame: false }
  return { url: frame.url, isMainFrame: target.mainFrame !== null && frame === target.mainFrame }
}

export const validateSender = (snapshot: FrameSnapshot, rules: ReadonlyArray<OriginRule>): boolean => {
  if (snapshot.url === null || !snapshot.isMainFrame) return false
  let parsed: URL
  try {
    parsed = new URL(snapshot.url)
  } catch {
    return false
  }
  return rules.some((rule) =>
    rule._tag === "fileProtocol" ? parsed.protocol === "file:" : parsed.origin === rule.origin
  )
}

/** Cheap DoS guard. Unserializable payloads count as oversized. */
export const payloadSize = (payload: unknown): number => {
  if (payload === undefined || payload === null) return 0
  if (typeof payload === "string") return payload.length
  try {
    return JSON.stringify(payload)?.length ?? 0
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024
