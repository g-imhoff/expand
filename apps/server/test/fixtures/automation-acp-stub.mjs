import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";

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
      send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "stub-acp", version: "0.0.0" } } });
      return;
    }
    if (method === "session/new") {
      counter += 1;
      send({ jsonrpc: "2.0", id, result: { sessionId: `ses-stub-${counter}` } });
      return;
    }
    if (method === "session/prompt") {
      const sessionId = params.sessionId ?? `ses-stub-${counter}`;
      const promptParts = Array.isArray(params.prompt) ? params.prompt : [];
      const text = promptParts.map((p) => (typeof p.text === "string" ? p.text : "")).join("\n");
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stub working" } } } });
      const sleepMatch = /sleep:(\d+)/.exec(text);
      if (sleepMatch) {
        const ms = Math.min(10000, Number(sleepMatch[1]));
        await new Promise((r) => setTimeout(r, ms));
      }
      const writeMatch = /write:([^:\s]+):([^\n]+)/.exec(text);
      if (writeMatch) {
        const filename = writeMatch[1];
        const content = writeMatch[2];
        const safe = path.basename(filename);
        await fs.writeFile(path.join(process.cwd(), safe), `${content}\n`, "utf-8");
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `wrote ${safe}` } } } });
      }
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
