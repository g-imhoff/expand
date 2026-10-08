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
}
export interface GmailStubMessage {
  readonly threadId: string
  readonly historyId: string
  readonly labelIds: Array<string>
  readonly from: string
  readonly subject: string
  readonly body: string
  readonly snippet: string
}
export interface GmailStub {
  readonly baseUrl: string
  readonly calls: Array<GmailStubCall>
  readonly setReply: (reply: (call: GmailStubCall) => GmailStubReply) => void
  readonly clearReply: () => void
  readonly setMessage: (messageId: string, message: GmailStubMessage) => void
  readonly getMessageLabels: (messageId: string) => ReadonlyArray<string> | null
  readonly setHistoryId: (historyId: string) => void
  readonly close: () => void
}

export {
  startGmailStub
}

const GmailStubBodyJson = Schema.fromJsonString(Schema.Unknown)
const startGmailStub = Effect.fn("GmailStub.start")(function* () {
  let reply: ((call: GmailStubCall) => GmailStubReply) | null = null
  const calls: Array<GmailStubCall> = []
  const messages = new Map<string, { threadId: string; historyId: string; labelIds: Array<string>; from: string; subject: string; body: string; snippet: string }>()
  let currentHistoryId = "100"
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const text: Array<string> = []
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      text.push(chunk)
    })
    request.on("end", () => {
      const rawPath = request.url ?? "/"
      const queryIndex = rawPath.indexOf("?")
      const path = (queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath).split("?")[0] ?? "/"
      const query = queryIndex >= 0 ? rawPath.slice(queryIndex + 1) : ""
      const call: GmailStubCall = {
        method: request.method ?? "GET",
        path: query.length > 0 ? `${path}?${query}` : path,
        authorization: request.headers.authorization,
        body: parseBody(text.join(""))
      }
      calls.push(call)
      if (call.authorization === undefined) {
        response.writeHead(401, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)({ message: "Requires authentication" } as unknown as Schema.Json))
        return
      }
      if (reply !== null) {
        const next = reply(call)
        response.writeHead(next.status, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)(next.body as Schema.Json))
        return
      }
      const profileMatch = path.match(/^\/gmail\/v1\/users\/[^/]+\/profile$/u)
      if (call.method === "GET" && profileMatch) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)({ historyId: currentHistoryId } as unknown as Schema.Json))
        return
      }
      const listMatch = path.match(/^\/gmail\/v1\/users\/[^/]+\/messages$/u)
      if (call.method === "GET" && listMatch) {
        const items = [...messages.entries()].map(([id, stored]) => ({ id, threadId: stored.threadId }))
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)({ messages: items, resultSizeEstimate: items.length } as unknown as Schema.Json))
        return
      }
      const historyMatch = path.match(/^\/gmail\/v1\/users\/[^/]+\/history$/u)
      if (call.method === "GET" && historyMatch) {
        const params = new URLSearchParams(query)
        const start = params.get("startHistoryId") ?? ""
        if (start.length === 0) {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GmailStubBodyJson)({ message: "Missing history marker" } as unknown as Schema.Json))
          return
        }
        if (start === currentHistoryId) {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GmailStubBodyJson)({ history: [], historyId: currentHistoryId } as unknown as Schema.Json))
          return
        }
        const added = [...messages.entries()].map(([id, stored]) => ({ message: { id, threadId: stored.threadId } }))
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)({ history: [{ messagesAdded: added }], historyId: currentHistoryId } as unknown as Schema.Json))
        return
      }
      const getMatch = path.match(/^\/gmail\/v1\/users\/[^/]+\/messages\/([^/]+)$/u)
      if (call.method === "GET" && getMatch) {
        const messageId = decodeURIComponent(getMatch[1] ?? "")
        const stored = messages.get(messageId)
        if (!stored) {
          response.writeHead(404, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GmailStubBodyJson)({ message: "Not Found" } as unknown as Schema.Json))
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)({
          id: messageId,
          threadId: stored.threadId,
          historyId: stored.historyId,
          labelIds: [...stored.labelIds],
          snippet: stored.snippet,
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: stored.from },
              { name: "Subject", value: stored.subject }
            ],
            body: { data: Buffer.from(stored.body, "utf8").toString("base64url") }
          }
        } as unknown as Schema.Json))
        return
      }
      const modifyMatch = path.match(/^\/gmail\/v1\/users\/[^/]+\/messages\/([^/]+)\/modify$/u)
      if (call.method === "POST" && modifyMatch) {
        const messageId = decodeURIComponent(modifyMatch[1] ?? "")
        const stored = messages.get(messageId)
        if (!stored) {
          response.writeHead(404, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GmailStubBodyJson)({ message: "Not Found" } as unknown as Schema.Json))
          return
        }
        let parsed: unknown = null
        try {
          parsed = Schema.decodeUnknownSync(Schema.Struct({ addLabelIds: Schema.Array(Schema.String), removeLabelIds: Schema.Array(Schema.String) }))(call.body)
        } catch {
          response.writeHead(400, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GmailStubBodyJson)({ message: "Bad modify payload" } as unknown as Schema.Json))
          return
        }
        const changes = parsed as { addLabelIds: Array<string>; removeLabelIds: Array<string> }
        for (const label of changes.addLabelIds) {
          if (!stored.labelIds.includes(label)) stored.labelIds.push(label)
        }
        stored.labelIds = stored.labelIds.filter((label) => !changes.removeLabelIds.includes(label))
        const numeric = Number.parseInt(currentHistoryId, 10)
        currentHistoryId = Number.isSafeInteger(numeric) ? String(numeric + 1) : currentHistoryId
        stored.historyId = currentHistoryId
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GmailStubBodyJson)({ id: messageId, threadId: stored.threadId, labelIds: [...stored.labelIds] } as unknown as Schema.Json))
        return
      }
      response.writeHead(404, { "content-type": "application/json" })
      response.end(Schema.encodeSync(GmailStubBodyJson)({ message: "Not Found" } as unknown as Schema.Json))
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
    setReply: (next) => {
      reply = next
    },
    clearReply: () => {
      reply = null
    },
    setMessage: (messageId, message) => {
      messages.set(messageId, { threadId: message.threadId, historyId: message.historyId, labelIds: [...message.labelIds], from: message.from, subject: message.subject, body: message.body, snippet: message.snippet })
    },
    getMessageLabels: (messageId) => {
      const stored = messages.get(messageId)
      return stored ? [...stored.labelIds] : null
    },
    setHistoryId: (historyId) => {
      currentHistoryId = historyId
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
  return stub
})
function parseBody(raw: string): unknown {
  if (raw.length === 0) return null
  try {
    return Schema.decodeUnknownSync(GmailStubBodyJson)(raw)
  } catch {
    return null
  }
}
