// Minimal line-delimited JSON-RPC stdio MCP stub, speaking the same framing
// lib/mcp-client.ts hand-rolls (no @modelcontextprotocol/sdk on this
// template). Responds to `initialize`, echoes back its own pid via the
// `sera.echo_pid` tool (so a test can tell whether a call landed on the
// original subprocess or a respawned one), and exits without responding to
// `sera.crash_now` to simulate an unexpected subprocess death.
let buf = "";

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-sera-mcp", version: "0.0.0" },
      });
      continue;
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      if (name === "sera.crash_now") {
        process.exit(1);
      }
      if (name === "sera.echo_pid") {
        respond(msg.id, { content: [{ type: "text", text: JSON.stringify({ pid: process.pid }) }] });
        continue;
      }
      respond(msg.id, { content: [{ type: "text", text: "{}" }] });
    }
    // Notifications (e.g. notifications/initialized) intentionally get no response.
  }
});
