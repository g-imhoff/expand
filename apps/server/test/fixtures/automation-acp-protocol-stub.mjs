import readline from "node:readline";
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
      send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "stub-protocol", version: "0.0.0" } } });
      return;
    }
    if (method === "session/new") {
      counter += 1;
      send({ jsonrpc: "2.0", id, result: { sessionId: `ses-protocol-${counter}` } });
      return;
    }
    if (method === "session/prompt") {
      const sessionId = params.sessionId ?? `ses-protocol-${counter}`;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "protocol working" } } } });
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom protocol failure" } });
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
