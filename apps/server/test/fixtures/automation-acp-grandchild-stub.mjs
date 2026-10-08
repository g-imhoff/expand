import readline from "node:readline";
import { spawn } from "node:child_process";
import fs from "node:fs";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let counter = 0;
const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const id = msg.id;
  const method = msg.method;
  const params = msg.params ?? {};
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "stub-grandchild", version: "0.0.0" } } });
      return;
    }
    if (method === "session/new") {
      counter += 1;
      send({ jsonrpc: "2.0", id, result: { sessionId: `ses-grandchild-${counter}` } });
      return;
    }
    if (method === "session/prompt") {
      const sessionId = params.sessionId ?? `ses-grandchild-${counter}`;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "grandchild working" } } } });
      try {
        const grandchild = spawn("sleep", ["30"], { stdio: "ignore" });
        const target = process.env["GRANDCHILD_PID_FILE"] ?? `${process.cwd()}/grandchild.pid`;
        try {
          fs.writeFileSync(target, `${grandchild.pid ?? 0}\n`, "utf-8");
        } catch {}
        try {
          grandchild.unref();
        } catch {}
      } catch {}
      await new Promise((r) => setTimeout(r, 10000));
      send({ jsonrpc: "2.0", id, result: { stopReason: "endTurn" } });
      return;
    }
    if (method === "session/cancel") {
      send({ jsonrpc: "2.0", id, result: null });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message ?? e) } });
  }
});
