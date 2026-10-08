import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Effect, Schema } from "effect"

export interface SonarStubCall {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
}

export interface SonarStubReply {
  readonly status: number
  readonly body: unknown
}

export interface SonarStubIssue {
  readonly status: string
  readonly severity: string
  readonly rule: string
  readonly message: string
  readonly component?: string
  readonly line?: number
}

export interface SonarStub {
  readonly baseUrl: string
  readonly calls: Array<SonarStubCall>
  readonly setReply: (reply: (call: SonarStubCall) => SonarStubReply) => void
  readonly clearReply: () => void
  readonly setIssue: (issueKey: string, issue: SonarStubIssue) => void
  readonly getIssue: (issueKey: string) => SonarStubIssue | null
  readonly close: () => void
}

export {
  startSonarStub
}


const SonarStubBodyJson = Schema.fromJsonString(Schema.Unknown)

const startSonarStub = Effect.fn("SonarStub.start")(function*() {
  let reply: ((call: SonarStubCall) => SonarStubReply) | null = null
  const calls: Array<SonarStubCall> = []
  const issues = new Map<string, SonarStubIssue>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.setEncoding("utf8")
    request.on("data", () => {})
    request.on("end", () => {
      const rawPath = request.url ?? "/"
      const queryIndex = rawPath.indexOf("?")
      const path = (queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath).split("?")[0] ?? "/"
      const query = queryIndex >= 0 ? rawPath.slice(queryIndex + 1) : ""
      const call: SonarStubCall = {
        method: request.method ?? "GET",
        path: query.length > 0 ? `${path}?${query}` : path,
        authorization: request.headers.authorization
      }
      calls.push(call)
      if (call.authorization === undefined) {
        response.writeHead(401, { "content-type": "application/json" })
        response.end(Schema.encodeSync(SonarStubBodyJson)({ message: "Requires authentication" } as unknown as Schema.Json))
        return
      }
      if (reply !== null) {
        const next = reply(call)
        response.writeHead(next.status, { "content-type": "application/json" })
        response.end(Schema.encodeSync(SonarStubBodyJson)(next.body as Schema.Json))
        return
      }
      if (call.method === "GET" && path === "/api/issues/search") {
        const params = new URLSearchParams(query)
        const single = params.get("issues") ?? ""
        if (single.length > 0) {
          const stored = issues.get(single)
          if (stored === undefined) {
            response.writeHead(200, { "content-type": "application/json" })
            response.end(Schema.encodeSync(SonarStubBodyJson)({ total: 0, issues: [] } as unknown as Schema.Json))
            return
          }
          response.writeHead(200, { "content-type": "application/json" })
          response.end(Schema.encodeSync(SonarStubBodyJson)({
            total: 1,
            issues: [{ key: single, status: stored.status, severity: stored.severity, rule: stored.rule, message: stored.message, ...(stored.component === undefined ? {} : { component: stored.component }), ...(stored.line === undefined ? {} : { line: stored.line }) }]
          } as unknown as Schema.Json))
          return
        }
        const items = [...issues.entries()].filter((entry) => entry[1].status === "OPEN" || entry[1].status === "CONFIRMED" || entry[1].status === "REOPENED").map(([key, stored]) => ({
          key, status: stored.status, severity: stored.severity, rule: stored.rule, message: stored.message
        }))
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(SonarStubBodyJson)({ total: items.length, issues: items } as unknown as Schema.Json))
        return
      }
      response.writeHead(404, { "content-type": "application/json" })
      response.end(Schema.encodeSync(SonarStubBodyJson)({ message: "Not Found" } as unknown as Schema.Json))
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
  const stub: SonarStub = {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    setReply: (next) => {
      reply = next
    },
    clearReply: () => {
      reply = null
    },
    setIssue: (issueKey, issue) => {
      issues.set(issueKey, { status: issue.status, severity: issue.severity, rule: issue.rule, message: issue.message, ...(issue.component === undefined ? {} : { component: issue.component }), ...(issue.line === undefined ? {} : { line: issue.line }) })
    },
    getIssue: (issueKey) => {
      const stored = issues.get(issueKey)
      return stored ? { ...stored } : null
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    }
  }
  return stub
})
