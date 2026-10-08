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
      send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "stub-flood", version: "0.0.0" } } });
      return;
    }
    if (method === "session/new") {
      counter += 1;
      send({ jsonrpc: "2.0", id, result: { sessionId: `ses-flood-${counter}` } });
      return;
    }
    if (method === "session/prompt") {
      const sessionId = params.sessionId ?? `ses-flood-${counter}`;
      for (let i = 0; i < 200; i++) {
        process.stderr.write(`flood-stderr-${i}-${"e".repeat(1024)}\n`);
      }
      for (let i = 0; i < 500; i++) {
        process.stdout.write(`not-json-malformed-${i} {{{\n`);
      }
      process.stdout.write(`${"x".repeat(2000000)}\n`);
      for (let i = 0; i < 300; i++) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 900000 + i, result: { filler: i } })}\n`);
      }
      process.stdout.write(`${"x".repeat(2000000)}\n`);
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "flood working" } } } });
      for (let i = 0; i < 300; i++) {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `flood-update-${i}` } } } });
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
