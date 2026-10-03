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
}

export interface GithubStubIssue {
  readonly title: string
  readonly body?: string
  readonly labels: Array<string>
}

export interface GithubStub {
  readonly baseUrl: string
  readonly calls: Array<GithubStubCall>
  readonly setReply: (reply: (call: GithubStubCall) => GithubStubReply) => void
  readonly setLabels: (labels: ReadonlyArray<string>) => void
  readonly setIssue: (issueNumber: number, issue: GithubStubIssue) => void
  readonly getIssueLabels: (issueNumber: number) => ReadonlyArray<string> | null
  readonly close: () => void
}

export const GithubStubBodyJson = Schema.fromJsonString(Schema.Unknown)

export const startGithubStub = Effect.fn("GithubStub.start")(function* () {
  let reply: ((call: GithubStubCall) => GithubStubReply) | null = null
  const calls: Array<GithubStubCall> = []
  const labels: Array<string> = []
  const issues = new Map<number, { title: string; body?: string; labels: Array<string> }>()
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const text: Array<string> = []
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => {
      text.push(chunk)
    })
    request.on("end", () => {
      const rawPath = request.url ?? "/"
      const path = rawPath.split("?")[0] ?? "/"
      const call: GithubStubCall = {
        method: request.method ?? "GET",
        path,
        authorization: request.headers.authorization,
        body: parseBody(text.join(""))
      }
      calls.push(call)
      if (call.authorization === undefined) {
        response.writeHead(401, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GithubStubBodyJson)({ message: "Requires authentication" } as unknown as Schema.Json))
        return
      }
      if (reply !== null) {
        const next = reply(call)
        response.writeHead(next.status, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GithubStubBodyJson)(next.body as Schema.Json))
        return
      }
      const issueMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)(\/labels)?$/u)
      if (call.method === "GET" && path.match(/^\/repos\/[^/]+\/[^/]+\/labels$/u)) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(Schema.encodeSync(GithubStubBodyJson)(labels.map((name) => ({ name })) as unknown as Schema.Json))
        return
      }
      if (issueMatch) {
        const issueNumber = Number(issueMatch[1])
        const stored = issues.get(issueNumber)
        if (!stored) {
          response.writeHead(404, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GithubStubBodyJson)({ message: "Not Found" } as unknown as Schema.Json))
          return
        }
        if (call.method === "GET" && issueMatch[2] === "/labels") {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GithubStubBodyJson)(stored.labels.map((name) => ({ name })) as unknown as Schema.Json))
          return
        }
        if (call.method === "GET" && issueMatch[2] === undefined) {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GithubStubBodyJson)({
            number: issueNumber,
            title: stored.title,
            ...(stored.body === undefined ? {} : { body: stored.body }),
            labels: stored.labels.map((name) => ({ name }))
          } as unknown as Schema.Json))
          return
        }
        if (call.method === "POST" && issueMatch[2] === "/labels") {
          let parsed: unknown = null
          try {
            parsed = Schema.decodeUnknownSync(Schema.Struct({ labels: Schema.Array(Schema.String) }))(call.body)
          } catch {
            response.writeHead(422, { "content-type": "application/json" })
            response.end(Schema.encodeSync(GithubStubBodyJson)({ message: "Validation Failed" } as unknown as Schema.Json))
            return
          }
          const names = (parsed as { labels: Array<string> }).labels
          for (const name of names) {
            if (!stored.labels.includes(name)) stored.labels.push(name)
          }
          response.writeHead(200, { "content-type": "application/json" })
          response.end(Schema.encodeSync(GithubStubBodyJson)(stored.labels.map((name) => ({ name })) as unknown as Schema.Json))
          return
        }
      }
      response.writeHead(404, { "content-type": "application/json" })
      response.end(Schema.encodeSync(GithubStubBodyJson)({ message: "Not Found" } as unknown as Schema.Json))
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
    setLabels: (next) => {
      labels.length = 0
      for (const name of next) labels.push(name)
    },
    setIssue: (issueNumber, issue) => {
      issues.set(issueNumber, { title: issue.title, ...(issue.body === undefined ? {} : { body: issue.body }), labels: [...issue.labels] })
    },
    getIssueLabels: (issueNumber) => {
      const stored = issues.get(issueNumber)
      return stored ? [...stored.labels] : null
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
    return Schema.decodeUnknownSync(GithubStubBodyJson)(raw)
  } catch {
    return null
  }
}
