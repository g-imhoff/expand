import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Effect, Schema } from "effect"

export interface GithubStubCall {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: unknown
}

export interface GithubStubReply {
  readonly status: number
  readonly body: unknown
  readonly headers?: Record<string, string>
  readonly hang?: boolean
}

export interface GithubStub {
  readonly baseUrl: string
  readonly calls: Array<GithubStubCall>
  readonly setReply: (reply: (call: GithubStubCall, index: number) => GithubStubReply) => void
  readonly close: () => void
}

export const githubLabelsBody = (names: ReadonlyArray<string>): unknown =>
  names.map((name, index) => ({ id: 1000 + index, node_id: `stub-${index}`, name, color: "ededed", default: false, description: null }))

export const githubIssueBody = (input: { readonly labels: ReadonlyArray<string>; readonly title?: string; readonly body?: string }): unknown => ({
  id: 4242, node_id: "stub-issue", number: 7, title: input.title ?? "Stub issue",
  body: input.body ?? null, labels: input.labels.map((name) => ({ id: name.length, node_id: `stub-${name}`, name, color: "ededed", default: false, description: null }))
})

export const githubRateLimitBody = (input?: { readonly limit?: number; readonly remaining?: number; readonly reset?: number }): unknown => ({
  resources: { core: { limit: input?.limit ?? 60, remaining: input?.remaining ?? 59, reset: input?.reset ?? 3600, used: 1 } },
  rate: { limit: input?.limit ?? 60, remaining: input?.remaining ?? 59, reset: input?.reset ?? 3600, used: 1 }
})

export const startGithubStub = Effect.fn("GithubStub.start")(function*() {
  let reply: (call: GithubStubCall, index: number) => GithubStubReply = () => ({ status: 500, body: { error: "responder not configured" } })
  const calls: Array<GithubStubCall> = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const text: Array<string> = []
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      text.push(chunk)
    })
    request.on("end", () => {
      const call: GithubStubCall = {
        method: request.method ?? "GET", path: request.url ?? "/",
        authorization: request.headers.authorization, body: parseStubBody(text.join(""))
      }
      calls.push(call)
      const next = reply(call, calls.length)
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
  const stub: GithubStub = {
    baseUrl: `http://127.0.0.1:${port}`,
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
  if (raw.length === 0) return null
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(raw)
  } catch {
    return null
  }
}
