import { ENVELOPE_VERSION, type ErrorCode, type ErrorEnvelope } from "@yodea/cli/contract/envelope"

export const makeEnvelope = (
  code: ErrorCode,
  message: string,
  retryable: boolean,
  extra?: { input?: unknown; hint?: string }
): ErrorEnvelope => ({
  apiVersion: ENVELOPE_VERSION,
  kind: "Error",
  code,
  message,
  retryable,
  ...(extra?.input !== undefined ? { input: extra.input } : {}),
  ...(extra?.hint !== undefined ? { hint: extra.hint } : {})
})

export const tagOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "_tag" in e ? (e as { _tag: string })._tag : undefined
