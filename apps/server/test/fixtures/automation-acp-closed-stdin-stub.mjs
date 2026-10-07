import { closeSync, writeFileSync } from "node:fs"
import readline from "node:readline"

const mode = process.argv[2]
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const closeInput = () => {
  rl.close()
  closeSync(0)
  writeFileSync(process.env["ACP_STDIN_CLOSED_FILE"], "closed")
}

writeFileSync(process.env["ACP_PID_FILE"], `${process.pid}`)
setInterval(() => {}, 1000)
rl.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } })
  } else if (message.method === "session/new") {
    if (mode === "prompt") {
      setImmediate(() => {
        closeInput()
        send({ jsonrpc: "2.0", method: "session/update", params: { text: "stdin closed" } })
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "closed-stdin" } })
      })
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "closed-stdin" } })
    }
  } else if (message.method === "session/prompt") {
    setImmediate(closeInput)
  }
})
