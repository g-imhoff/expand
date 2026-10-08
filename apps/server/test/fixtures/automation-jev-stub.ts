import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Effect, Schema } from "effect"

export interface JevStubCall {
  readonly authorization: string | undefined
  readonly body: unknown
}

export interface JevStubReply {
  readonly status: number
  readonly body: unknown
  readonly hang?: boolean
}

export interface JevStub {
  readonly url: string
  readonly calls: Array<JevStubCall>
  readonly setReply: (reply: (call: JevStubCall) => JevStubReply) => void
  readonly close: () => void
}

export const stubChoiceBody = (choice: string, probabilities: Record<string, number>, confidence: number, questionId = "decision"): unknown => ({
  model: "jev-1.13.0",
  answers: { [questionId]: { type: "choice", choice, probabilities, confidence } },
  usage: { input_tokens: 12, output_tokens: 6 }
})

export const startJevStub = Effect.fn("JevStub.start")(function*() {
  let reply: (call: JevStubCall) => JevStubReply = () => ({ status: 500, body: { error: "responder not configured" } })
  const calls: Array<JevStubCall> = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const text: Array<string> = []
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      text.push(chunk)
    })
    request.on("end", () => {
      const call: JevStubCall = { authorization: request.headers.authorization, body: parseStubBody(text.join("")) }
      calls.push(call)
      const next = reply(call)
      if (next.hang === true) return
      response.writeHead(next.status, { "content-type": "application/json" })
      response.end(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(next.body as Schema.Json))
    })
  })
  server.unref()
  server.listen(0, "127.0.0.1")
  let port: number | null = null
  while (port === null) {
    const address = server.address()
    if (address !== null && typeof address === "object") port = address.port
    else yield* Effect.sleep("5 millis")
  }
  const stub: JevStub = {
    url: `http://127.0.0.1:${port}/zen/v1/systemone`,
    calls,
    setReply: (next) => {
      reply = next
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
  return stub
})

function parseStubBody(raw: string): unknown {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(raw)
  } catch {
    return null
  }
}
