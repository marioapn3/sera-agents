/**
 * Minimal stdio JSON-RPC client for sera-mcp.
 *
 * Spawns sera-mcp once, holds the subprocess open, and exposes a tiny
 * `tool(name, args)` helper. No OpenAI Agents SDK — the inner loop is
 * deterministic; an LLM bridge would only add latency and failure modes.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface SeraMcpClientOptions {
  mcpPath: string;
  env?: Record<string, string | undefined>;
  /** Per-request timeout in ms. Default 30s. */
  requestTimeoutMs?: number;
}

export interface SeraMcpClient {
  /** Call a sera.* tool and parse the text-JSON response back into an object. */
  tool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Raw RPC for advanced uses. */
  rpc(method: string, params?: unknown): Promise<any>;
  close(): void;
  running(): boolean;
}

interface PendingEntry {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

/**
 * One spawned sera-mcp subprocess generation: its own process, its own
 * in-flight requests, and its own handshake state. `initialized` lives here
 * (not as a variable shared across generations) so a delayed response
 * belonging to a superseded generation can never be mistaken for the
 * currently-active one having completed its handshake.
 */
interface Connection {
  proc: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingEntry>;
  initialized: boolean;
}

export async function startSeraMcp(opts: SeraMcpClientOptions): Promise<SeraMcpClient> {
  let conn: Connection | null = null;
  let reqId = 0;
  // Serializes concurrent (re)connect attempts so a crash mid-run doesn't let
  // several simultaneous tool()/rpc() callers each spawn/initialize their own
  // subprocess — every caller awaits this single in-flight attempt instead.
  let connectPromise: Promise<void> | null = null;
  const requestTimeout = opts.requestTimeoutMs ?? 30_000;

  // Forward only what the sera-mcp child legitimately needs — never spread the
  // full parent env. This bot signs Order structs client-side with
  // SIGNER_PRIVATE_KEY (the server-side signer is unused), so the hot wallet key
  // (and unrelated secrets like OPENAI_API_KEY) must not reach the subprocess:
  // it widens the blast radius of any leak/compromise in sera-mcp for no benefit.
  // The caller passes SERA_NETWORK / signer-mode / execution / policy via
  // opts.env; SERA_API_KEY/SECRET are passed through in case order placement
  // needs them.
  const ENV_PASSTHROUGH = [
    "PATH",
    "HOME",
    "LOGNAME",
    "SHELL",
    "TERM",
    "USER",
    "SERA_API_KEY",
    "SERA_API_SECRET",
  ];

  function spawnConnection(): Connection {
    const base: NodeJS.ProcessEnv = {};
    for (const k of ENV_PASSTHROUGH) {
      if (process.env[k] !== undefined) base[k] = process.env[k];
    }
    const env: NodeJS.ProcessEnv = { ...base, ...opts.env };
    const p = spawn("node", [opts.mcpPath], { env, stdio: ["pipe", "pipe", "pipe"] });
    // Each generation gets its own pending map. A crashed/closed process's
    // exit handler must only ever touch requests it is actually holding —
    // never a replacement process's in-flight requests.
    const pending = new Map<number, PendingEntry>();
    const connection: Connection = { proc: p, pending, initialized: false };
    let buf = "";
    p.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const h = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) h.reject(new Error(msg.error.message ?? "mcp error"));
            else h.resolve(msg.result);
          }
        } catch {
          /* non-JSON line — ignore */
        }
      }
    });
    p.stderr.on("data", (chunk) => process.stderr.write(`[mcp] ${chunk.toString("utf8")}`));
    p.on("exit", (code) => {
      process.stderr.write(`[mcp] exited code=${code}\n`);
      // Only this generation's own pending requests — a replacement
      // process's in-flight requests live in their own Map and are untouched.
      for (const [, h] of pending) h.reject(new Error("mcp subprocess exited"));
      pending.clear();
      // A killed process's `exit` event fires asynchronously and can land
      // after ensureConnected() already spawned + swapped in a replacement —
      // guard against a stale event from a superseded generation clobbering
      // the currently-active connection.
      if (conn === connection) {
        conn = null;
      }
    });
    return connection;
  }

  function sendRpcOn(target: Connection, method: string, params: unknown = {}): Promise<any> {
    const id = ++reqId;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      target.pending.set(id, { resolve, reject });
      target.proc.stdin.write(payload);
      setTimeout(() => {
        if (target.pending.has(id)) {
          target.pending.delete(id);
          reject(new Error(`mcp ${method} timeout after ${requestTimeout}ms`));
        }
      }, requestTimeout);
    });
  }

  function sendRpc(method: string, params: unknown = {}): Promise<any> {
    if (!conn) throw new Error("mcp not running");
    return sendRpcOn(conn, method, params);
  }

  async function doConnect(): Promise<void> {
    // Capture the generation this attempt is working on. `conn` is mutable
    // shared state — if close() (or a crash) supersedes it while we're
    // spawning/handshaking, every check below must notice and back off
    // instead of mutating state that no longer belongs to the active
    // connection.
    let target = conn;
    if (!target) {
      target = spawnConnection();
      conn = target;
      await new Promise((r) => setTimeout(r, 250));
      if (conn !== target) return; // superseded during the spawn delay
    }
    if (target.initialized) return;
    try {
      await sendRpcOn(target, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sera-market-maker", version: "0.2.0" },
      });
    } catch (e) {
      // Handshake failed (subprocess died, timed out, ...) — discard this
      // generation so the next ensureConnected() starts a clean respawn
      // rather than reusing a half-initialized connection. Only touch
      // `conn` if this generation is still the active one.
      if (conn === target) conn = null;
      throw e;
    }
    // Only mark *this* generation initialized if it's still the active one.
    // A delayed `initialize` response that arrives after close()/a crash
    // superseded it must not be mistaken for the current connection (or
    // whatever generation happens to be current by then) being ready.
    if (conn === target) {
      target.initialized = true;
    }
  }

  // Connects (if needed) and completes the initialize handshake (if not done
  // yet on this generation). Called before every tool/rpc call, not just at
  // startup — a subprocess crash mid-run resets `conn` via the exit handler
  // above, and without re-checking here every call after that would fail
  // forever with "mcp not running" instead of recovering, silently wedging a
  // long-running caller like market-maker's poll loop. Concurrent callers
  // share one in-flight `connectPromise` rather than each racing their own
  // spawn + `initialize`.
  function ensureConnected(): Promise<void> {
    if (conn?.initialized) return Promise.resolve();
    if (!connectPromise) {
      const attempt: Promise<void> = doConnect().finally(() => {
        if (connectPromise === attempt) connectPromise = null;
      });
      connectPromise = attempt;
    }
    return connectPromise;
  }

  await ensureConnected();

  return {
    async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      await ensureConnected();
      const r = await sendRpc("tools/call", { name, arguments: args });
      if (r?.isError) {
        throw new Error(`${name}: ${r.content?.[0]?.text ?? "tool error"}`);
      }
      const text = r?.content?.[0]?.text;
      if (typeof text !== "string") throw new Error(`${name}: no text content`);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
    async rpc(method: string, params?: unknown) {
      await ensureConnected();
      return sendRpc(method, params);
    },
    close() {
      if (conn) {
        conn.proc.kill();
        conn = null;
      }
      // Drop any in-flight (re)connect attempt too — a caller after close()
      // must start a fresh spawn, not await a handshake for the generation
      // we just killed.
      connectPromise = null;
    },
    running() {
      return !!conn;
    },
  };
}
