import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startSeraMcp } from "../lib/mcp-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-sera-mcp.mjs", import.meta.url));

describe("startSeraMcp", () => {
  it("connects and completes the initialize handshake", async () => {
    const mcp = await startSeraMcp({ mcpPath: fixturePath });
    try {
      const r = await mcp.tool<{ pid: number }>("sera.echo_pid");
      expect(typeof r.pid).toBe("number");
      expect(mcp.running()).toBe(true);
    } finally {
      mcp.close();
    }
  });

  /**
   * Regression test: lib/mcp-client.ts used to spawn the subprocess once at
   * startSeraMcp() and never again. If it died mid-run (OOM, transient
   * failure, ...) every subsequent tool() call threw "mcp not running"
   * forever — market-maker's poll loop swallows tick errors
   * (lib/loop.ts's runOneTick) and keeps polling, so the bot would silently
   * wedge instead of crashing loudly or recovering. tool()/rpc() now call
   * ensureConnected() first, which respawns + re-handshakes when the
   * subprocess is gone.
   */
  it("recovers after the subprocess crashes instead of failing forever", async () => {
    const mcp = await startSeraMcp({ mcpPath: fixturePath });
    try {
      const before = await mcp.tool<{ pid: number }>("sera.echo_pid");

      await expect(mcp.tool("sera.crash_now")).rejects.toThrow(/mcp subprocess exited/);
      // Let the child's `exit` event fire and flip proc/initialized back to unset.
      await new Promise((r) => setTimeout(r, 50));
      expect(mcp.running()).toBe(false);

      // The next call must transparently respawn a fresh subprocess and
      // redo the initialize handshake, not throw "mcp not running" forever.
      const after = await mcp.tool<{ pid: number }>("sera.echo_pid");
      expect(after.pid).not.toBe(before.pid);
      expect(mcp.running()).toBe(true);
    } finally {
      mcp.close();
    }
  }, 10_000);

  it("close() lets a subsequent tool() call reconnect and re-initialize", async () => {
    const mcp = await startSeraMcp({ mcpPath: fixturePath });
    const before = await mcp.tool<{ pid: number }>("sera.echo_pid");

    mcp.close();
    expect(mcp.running()).toBe(false);

    const after = await mcp.tool<{ pid: number }>("sera.echo_pid");
    expect(after.pid).not.toBe(before.pid);
    mcp.close();
  }, 10_000);
});
