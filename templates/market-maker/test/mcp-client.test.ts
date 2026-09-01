import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startSeraMcp } from "../lib/mcp-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-sera-mcp.mjs", import.meta.url));

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!predicate()) throw new Error("waitUntil: condition not met in time");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  /**
   * Regression test for a review finding: `initialized` was a variable
   * shared across every generation rather than living on the Connection
   * object. Sequence: a reconnect spawns a replacement and sends its
   * `initialize`; close() supersedes that generation (conn = null) before
   * the (delayed) response arrives; the response then lands and used to
   * set the *global* `initialized = true`, which a later, completely
   * unrelated generation would then see and skip its own handshake —
   * sending tools/call to a process that was never actually initialized.
   * The fixture rejects tools/call before its own `initialize`, so this
   * surfaces as the exact "not initialized" error the reviewer reported.
   */
  it("a delayed init response after close() during reconnect can't skip the next generation's handshake", async () => {
    const mcp = await startSeraMcp({
      mcpPath: fixturePath,
      // Every generation this client spawns (including the very first)
      // delays its initialize response and, once killed, delays its own
      // exit — both needed to land the response for a closed generation
      // after close() has already run.
      env: { FAKE_MCP_INIT_DELAY_MS: "300", FAKE_MCP_EXIT_DELAY_MS: "500" },
    });
    try {
      const before = await mcp.tool<{ pid: number }>("sera.echo_pid");
      await expect(mcp.tool("sera.crash_now")).rejects.toThrow(/mcp subprocess exited/);

      // Reconnect starts (spawns a replacement, sends its initialize) but
      // don't await it — close() below supersedes it mid-handshake.
      const reconnecting = mcp.tool<{ pid: number }>("sera.echo_pid");

      // Land after the replacement's initialize has been sent (~250ms spawn
      // delay) but before its 300ms-delayed response arrives.
      await new Promise((r) => setTimeout(r, 350));
      mcp.close();
      await expect(reconnecting).rejects.toThrow();

      // Let the closed generation's delayed initialize response (and its
      // own delayed exit) land in the background.
      await new Promise((r) => setTimeout(r, 700));

      // A fresh call must do its own real handshake on a brand new
      // generation — not skip `initialize` because of a stale flag left
      // over from the closed generation's late response.
      const after = await mcp.tool<{ pid: number }>("sera.echo_pid");
      expect(after.pid).not.toBe(before.pid);
      expect(mcp.running()).toBe(true);
    } finally {
      mcp.close();
    }
  }, 15_000);

  /**
   * Regression test for a review finding: on a failed/timed-out handshake,
   * doConnect() used to null out `conn` without ever killing the process it
   * had just spawned — a child that returned an init error (or never
   * responded) but stayed alive would leak indefinitely, still holding
   * SERA_API_KEY/SECRET.
   */
  it("kills the subprocess and rejects when initialize errors, leaving nothing orphaned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-mcp-"));
    const pidFile = join(dir, "pid");
    await expect(
      startSeraMcp({
        mcpPath: fixturePath,
        env: { FAKE_MCP_FAIL_INIT: "error", FAKE_MCP_PIDFILE: pidFile },
      }),
    ).rejects.toThrow();

    await waitUntil(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitUntil(() => !isAlive(pid));
  });

  it("kills the subprocess and rejects when initialize times out, leaving nothing orphaned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-mcp-"));
    const pidFile = join(dir, "pid");
    await expect(
      startSeraMcp({
        mcpPath: fixturePath,
        env: { FAKE_MCP_FAIL_INIT: "hang", FAKE_MCP_PIDFILE: pidFile },
        requestTimeoutMs: 200,
      }),
    ).rejects.toThrow(/timeout/);

    await waitUntil(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitUntil(() => !isAlive(pid));
  });

  /**
   * Regression test for a review finding: a reconnect attempt superseded
   * mid-flight (by close(), here) used to resolve successfully anyway once
   * its post-spawn-delay check saw it had been superseded — its caller
   * would then proceed to send tools/call through whatever `conn` a LATER,
   * unrelated caller had since spawned, potentially before that replacement
   * had even finished its own handshake. A superseded attempt must reject
   * instead, and each caller must send its request through the exact
   * Connection its own ensureConnected() call resolved with.
   */
  it("rejects a superseded reconnect attempt instead of resolving it against a different generation", async () => {
    const mcp = await startSeraMcp({ mcpPath: fixturePath });
    try {
      await expect(mcp.tool("sera.crash_now")).rejects.toThrow(/mcp subprocess exited/);

      // Reconnect A starts (spawns a replacement) — don't await it yet.
      const callerA = mcp.tool<{ pid: number }>("sera.echo_pid");

      // Supersede it immediately, synchronously, while A is still inside
      // its post-spawn 250ms delay (before it has even sent `initialize`).
      mcp.close();

      // A must reject as superseded — never resolve using whatever
      // generation happens to be active by the time it settles.
      await expect(callerA).rejects.toThrow(/superseded/);

      // A fresh caller gets its own connection with its own real handshake.
      const callerB = await mcp.tool<{ pid: number }>("sera.echo_pid");
      expect(typeof callerB.pid).toBe("number");
      expect(mcp.running()).toBe(true);
    } finally {
      mcp.close();
    }
  }, 10_000);
});
