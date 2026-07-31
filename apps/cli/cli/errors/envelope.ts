import { Schema } from "effect"
import { makeEnvelope } from "@expand/cli/contract/envelope"
import { ENVELOPE_VERSION } from "@expand/cli/contract/version"
import { ErrorCode, type ErrorCode as ErrorCodeType } from "@expand/cli/errors/error-code"

export class ErrorEnvelope extends Schema.Opaque<ErrorEnvelope>()(
  Schema.Struct({
    apiVersion: Schema.Literal(ENVELOPE_VERSION),
    kind: Schema.Literal("Error"),
    code: ErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
    input: Schema.optional(Schema.Unknown),
    hint: Schema.optional(Schema.String)
  })
) {}

export const ErrorEnvelopeFromJson = Schema.fromJsonString(ErrorEnvelope)

export const makeErrorEnvelope = (
  code: ErrorCodeType,
  message: string,
  retryable: boolean,
  extra?: { input?: unknown; hint?: string }
): ErrorEnvelope => makeEnvelope("Error", {
  code,
  message,
  retryable,
  ...(extra?.input !== undefined ? { input: extra.input } : {}),
  ...(extra?.hint !== undefined ? { hint: extra.hint } : {})
})

export const tagOf = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "_tag" in e ? (e as { _tag: string })._tag : undefined
