import { Data, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export class ZenTransportError extends Data.TaggedError("ZenTransportError")<{
  readonly code: "auth" | "rate-limited" | "transient" | "invalid-contract"
  readonly message: string
  readonly status?: number
}> {}

export interface ZenPostInput {
  readonly endpoint: string
  readonly apiKey: string
  readonly body: unknown
}

export const ZenSystemOneEndpoint = "https://opencode.ai/zen/v1/systemone"
export const ZenJevModel = "jev-1.13"

export const ZenChoiceQuestion = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Schema.String.check(Schema.isMinLength(1)),
  criteria: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Null]))
})
export type ZenChoiceQuestion = typeof ZenChoiceQuestion.Type

export const ZenSystemOneRequest = Schema.Struct({
  model: Schema.Literal("jev-1.13"),
  state: Schema.Json,
  questions: Schema.Record(Schema.String, ZenChoiceQuestion)
})
export type ZenSystemOneRequest = typeof ZenSystemOneRequest.Type

export const ZenChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String.check(Schema.isMinLength(1)),
  probabilities: Schema.Record(
    Schema.String,
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
  ),
  confidence: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1))
})
export type ZenChoiceAnswer = typeof ZenChoiceAnswer.Type

export const ZenSystemOneResponse = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1)),
  answers: Schema.Record(Schema.String, ZenChoiceAnswer),
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  })
})
export type ZenSystemOneResponse = typeof ZenSystemOneResponse.Type

export const postSystemOne = Effect.fn("ZenTransport.postSystemOne")(function*(input: ZenPostInput) {
  if (typeof input.apiKey !== "string" || input.apiKey.length === 0) {
    return yield* new ZenTransportError({ code: "auth", message: "Zen rejected the API key" })
  }
  const endpoint = yield* Effect.try({
    try: () => new URL(input.endpoint).toString(),
    catch: () => new ZenTransportError({ code: "invalid-contract", message: "Zen endpoint is not a usable URL" })
  })
  const validated = yield* Schema.decodeUnknownEffect(ZenSystemOneRequest, { onExcessProperty: "error" })(input.body).pipe(
    Effect.mapError(() => new ZenTransportError({ code: "invalid-contract", message: "Jev request does not match the Zen contract" }))
  )
  const base = HttpClientRequest.post(endpoint).pipe(HttpClientRequest.bearerToken(input.apiKey))
  const outgoing = yield* HttpClientRequest.schemaBodyJson(ZenSystemOneRequest)(base, validated).pipe(
    Effect.mapError(() => new ZenTransportError({ code: "invalid-contract", message: "Jev request does not match the Zen contract" }))
  )
  const response = yield* HttpClient.execute(outgoing).pipe(
    Effect.mapError(() => new ZenTransportError({ code: "transient", message: "Zen transport failed" }))
  )
  if (response.status === 401 || response.status === 403) {
    return yield* new ZenTransportError({ code: "auth", message: "Zen rejected the API key", status: response.status })
  }
  if (response.status === 429) {
    return yield* new ZenTransportError({ code: "rate-limited", message: "Zen rate limit exceeded", status: response.status })
  }
  if (response.status === 422) {
    return yield* new ZenTransportError({ code: "invalid-contract", message: "Zen rejected the decision request", status: response.status })
  }
  if (response.status === 529 || response.status >= 500) {
    return yield* new ZenTransportError({ code: "transient", message: "Zen responded with a retryable failure", status: response.status })
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new ZenTransportError({ code: "invalid-contract", message: "Zen responded with an unexpected status", status: response.status })
  }
  return yield* HttpClientResponse.schemaBodyJson(ZenSystemOneResponse)(response).pipe(
    Effect.mapError(() => new ZenTransportError({ code: "invalid-contract", message: "Zen response does not match the decision contract", status: response.status }))
  )
})
