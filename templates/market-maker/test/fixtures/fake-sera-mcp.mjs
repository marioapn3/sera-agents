// Minimal line-delimited JSON-RPC stdio MCP stub, speaking the same framing
// lib/mcp-client.ts hand-rolls (no @modelcontextprotocol/sdk on this
// template). Responds to `initialize` exactly once per process (a second
// attempt errors, so a test can catch a client sending duplicate concurrent
// `initialize` calls), echoes back its own pid via the `sera.echo_pid` tool
// (so a test can tell whether a call landed on the original subprocess or a
// respawned one), and exits without responding to `sera.crash_now` to
// simulate an unexpected subprocess death.
//
// FAKE_MCP_EXIT_DELAY_MS (optional): if set, delays process exit on SIGTERM
// by that many ms, for tests that need a killed process's `exit` event to
// land well after a replacement has already been spawned and used.
//
// FAKE_MCP_INIT_DELAY_MS (optional): if set, delays the `initialize`
// *response* by that many ms (the request is still accepted immediately,
// so a concurrent duplicate still gets rejected below) — for tests that
// need a handshake response to arrive after the caller has already moved
// on (e.g. closed the connection).
let buf = "";
let initialized = false;

const exitDelayMs = Number(process.env.FAKE_MCP_EXIT_DELAY_MS ?? 0);
if (exitDelayMs > 0) {
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), exitDelayMs);
  });
}

const initDelayMs = Number(process.env.FAKE_MCP_INIT_DELAY_MS ?? 0);

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { message } })}\n`);
}

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      if (initialized) {
        respondError(msg.id, "already initialized");
        continue;
      }
      initialized = true;
      const sendInitResult = () => {
        respond(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-sera-mcp", version: "0.0.0" },
        });
      };
      if (initDelayMs > 0) setTimeout(sendInitResult, initDelayMs);
      else sendInitResult();
      continue;
    }
    if (msg.method === "tools/call") {
      if (!initialized) {
        respondError(msg.id, "not initialized");
        continue;
      }
      const name = msg.params?.name;
      if (name === "sera.crash_now") {
        process.exit(1);
      }
      if (name === "sera.echo_pid") {
        respond(msg.id, {
          content: [{ type: "text", text: JSON.stringify({ pid: process.pid }) }],
        });
        continue;
      }
      respond(msg.id, { content: [{ type: "text", text: "{}" }] });
    }
    // Notifications (e.g. notifications/initialized) intentionally get no response.
  }
});
