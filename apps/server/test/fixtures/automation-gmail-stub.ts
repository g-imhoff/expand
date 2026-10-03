import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Effect, Schema } from "effect"

export interface GmailStubCall {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: unknown
}

export interface GmailStubReply {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
  readonly hang?: boolean
}

export interface GmailStubMessage {
  readonly id: string
  readonly threadId?: string
  readonly labelIds: ReadonlyArray<string>
  readonly subject?: string
  readonly from?: string
  readonly snippet?: string
  readonly body?: string
  readonly historyId?: string
}

export interface GmailStub {
  readonly baseUrl: string
  readonly calls: Array<GmailStubCall>
  readonly messages: Map<string, GmailStubMessage>
  readonly setReply: (reply: (call: GmailStubCall, index: number) => GmailStubReply) => void
  readonly setMessages: (messages: ReadonlyArray<GmailStubMessage>) => void
  readonly close: () => void
}

export const gmailListBody = (messages: ReadonlyArray<GmailStubMessage>): unknown => ({
  messages: messages.map((entry) => ({
    id: entry.id,
    ...(entry.threadId === undefined ? {} : { threadId: entry.threadId })
  })),
  resultSizeEstimate: messages.length
})

export const gmailMessageBody = (message: GmailStubMessage): unknown => ({
  id: message.id,
  ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
  labelIds: [...message.labelIds],
  ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
  ...(message.historyId === undefined ? {} : { historyId: message.historyId }),
  payload: {
    headers: [
      ...(message.subject === undefined ? [] : [{ name: "Subject", value: message.subject }]),
      ...(message.from === undefined ? [] : [{ name: "From", value: message.from }])
    ],
    ...(message.body === undefined ? {} : { body: { data: message.body } })
  }
})

export const gmailProfileBody = (input?: { readonly emailAddress?: string; readonly historyId?: string }): unknown => ({
  emailAddress: input?.emailAddress ?? "tester@example.com",
  ...(input?.historyId === undefined ? {} : { historyId: input.historyId })
})

export const startGmailStub = Effect.fn("GmailStub.start")(function*() {
  let reply: ((call: GmailStubCall, index: number) => GmailStubReply) | null = null
  const calls: Array<GmailStubCall> = []
  const messages = new Map<string, GmailStubMessage>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const text: Array<string> = []
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      text.push(chunk)
    })
    request.on("end", () => {
      const call: GmailStubCall = {
        method: request.method ?? "GET", path: request.url ?? "/",
        authorization: request.headers.authorization, body: parseStubBody(text.join(""))
      }
      calls.push(call)
      const next = reply !== null
        ? reply(call, calls.length)
        : defaultReply(call, messages)
      if (next.hang === true) return
      response.writeHead(next.status, { ...next.headers, "content-type": "application/json" })
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
  const stub: GmailStub = {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    messages,
    setReply: (next) => {
      reply = next
    },
    setMessages: (next) => {
      messages.clear()
      for (const entry of next) messages.set(entry.id, entry)
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
  return stub
})

function defaultReply(call: GmailStubCall, messages: Map<string, GmailStubMessage>): GmailStubReply {
  const url = new URL(call.path, "http://127.0.0.1")
  if (call.method === "GET" && url.pathname.endsWith("/profile")) {
    return { status: 200, body: gmailProfileBody() }
  }
  if (call.method === "GET" && url.pathname.endsWith("/messages")) {
    return { status: 200, body: gmailListBody([...messages.values()]) }
  }
  const single = /^\/gmail\/v1\/users\/[^/]+\/messages\/([^/]+)$/u.exec(url.pathname)
  if (call.method === "GET" && single?.[1] !== undefined) {
    const message = messages.get(decodeURIComponent(single[1]))
    if (message === undefined) return { status: 404, body: { error: { message: "Not Found" } } }
    return { status: 200, body: gmailMessageBody(message) }
  }
  const modify = /^\/gmail\/v1\/users\/[^/]+\/messages\/([^/]+)\/modify$/u.exec(url.pathname)
  if (call.method === "POST" && modify?.[1] !== undefined) {
    const message = messages.get(decodeURIComponent(modify[1]))
    if (message === undefined) return { status: 404, body: { error: { message: "Not Found" } } }
    const parsed = call.body as { addLabelIds?: ReadonlyArray<string>; removeLabelIds?: ReadonlyArray<string> }
    const next = new Set(message.labelIds)
    for (const label of parsed.addLabelIds ?? []) next.add(label)
    for (const label of parsed.removeLabelIds ?? []) next.delete(label)
    const updated: GmailStubMessage = { ...message, labelIds: [...next] }
    messages.set(updated.id, updated)
    return { status: 200, body: { id: updated.id, threadId: updated.threadId, labelIds: [...next] } }
  }
  return { status: 404, body: { error: { message: "Not Found" } } }
}

function parseStubBody(raw: string): unknown {
  if (raw.length === 0) return null
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(raw)
  } catch {
    return null
  }
}
