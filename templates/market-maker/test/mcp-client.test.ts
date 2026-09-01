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

  /**
   * Regression test for a review finding: ensureConnected() used to check
   * `if (!proc)` / `if (!initialized)` with no locking, so several
   * concurrent tool()/rpc() calls racing in right after a crash could each
   * see `initialized === false` and each send their own `initialize`. The
   * fixture errors on a second `initialize` on the same process, so this
   * would previously reject some of the concurrent calls with
   * "already initialized". A shared `connectPromise` now serializes
   * reconnect attempts so exactly one `initialize` is ever sent per
   * generation.
   */
  it("serializes concurrent reconnects after a crash instead of double-initializing", async () => {
    const mcp = await startSeraMcp({ mcpPath: fixturePath });
    try {
      const before = await mcp.tool<{ pid: number }>("sera.echo_pid");
      await expect(mcp.tool("sera.crash_now")).rejects.toThrow(/mcp subprocess exited/);
      await new Promise((r) => setTimeout(r, 50));
      expect(mcp.running()).toBe(false);

      // Several callers race in at once against the dead connection. If any
      // of them sent its own `initialize`, the fixture would reject the
      // second one with "already initialized" and this Promise.all would
      // reject.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => mcp.tool<{ pid: number }>("sera.echo_pid")),
      );
      expect(results).toHaveLength(5);
      for (const r of results) {
        expect(r.pid).not.toBe(before.pid);
        expect(r.pid).toBe(results[0].pid); // exactly one respawn, not five
      }
    } finally {
      mcp.close();
    }
  }, 10_000);

  /**
   * Regression test for a review finding: the killed process's `exit` event
   * fires asynchronously and can land after ensureConnected() has already
   * spawned + used a replacement. Before the per-generation `pending` map
   * and the `conn?.proc === p` guard, that stale event rejected the
   * replacement's in-flight requests (or its connection state) with
   * "mcp subprocess exited" even though the replacement was healthy.
   */
  it("a delayed exit from a closed process doesn't affect the replacement connection", async () => {
    const mcp = await startSeraMcp({
      mcpPath: fixturePath,
      env: { FAKE_MCP_EXIT_DELAY_MS: "400" },
    });
    try {
      mcp.close(); // old process ignores SIGTERM for 400ms before actually exiting
      expect(mcp.running()).toBe(false);

      // Reconnects well before the old process's delayed exit fires.
      const after = await mcp.tool<{ pid: number }>("sera.echo_pid");
      expect(mcp.running()).toBe(true);

      // Wait past the old process's delayed exit and confirm its stale
      // `exit` event didn't tear down the (unrelated) replacement.
      await new Promise((r) => setTimeout(r, 500));
      expect(mcp.running()).toBe(true);

      const stillWorking = await mcp.tool<{ pid: number }>("sera.echo_pid");
      expect(stillWorking.pid).toBe(after.pid);
    } finally {
      mcp.close();
    }
  }, 10_000);
});
