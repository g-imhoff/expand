import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Schema } from "effect"

const [mode] = process.argv.slice(2)
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const sessionId = "stub-session-1"
let pending = 0
let finished = false
const reader = createInterface({ input: process.stdin })
const send = (value) => {
  pending += 1
  process.stdout.write(`${encode(value)}\n`, () => {
    pending -= 1
    if (finished && pending === 0) {
      reader.close()
      process.stdin.pause()
    }
  })
}
const update = (content) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content } }
})
reader.on("line", (line) => {
  if (line.trim().length === 0) return
  let parsed
  try {
    parsed = decode(line)
  } catch {
    return
  }
  const id = typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : 0
  if (parsed.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { session: true, prompt: true, cancel: true }, agentInfo: { name: "StubCodingAgent" } } })
    return
  }
  if (parsed.method === "session/new") {
    send({ jsonrpc: "2.0", id, result: { sessionId } })
    return
  }
  if (parsed.method === "session/prompt") {
    const allowed = process.env["CODING_ALLOWED_ACTIONS"] ?? "none"
    send(update(`allowed:${allowed}`))
    if (mode === "hang") return
    const credential = process.env["CODING_CREDENTIAL_TOKEN"]
    writeFileSync(
      join(process.cwd(), "hello.txt"),
      `edited-by:stub\ncredentialBytes:${credential === undefined ? "none" : String(credential.length)}\n`
    )
    send(update(`credentialBytes:${credential === undefined ? "none" : String(credential.length)}`))
    send(update("edited:hello.txt"))
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
    finished = true
    if (pending === 0) {
      reader.close()
      process.stdin.pause()
    }
  }
})
reader.on("close", () => {
  if (!finished) process.exitCode = 1
})
