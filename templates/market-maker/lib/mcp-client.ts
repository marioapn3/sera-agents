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

export async function startSeraMcp(opts: SeraMcpClientOptions): Promise<SeraMcpClient> {
  let proc: ChildProcessWithoutNullStreams | null = null;
  let initialized = false;
  let reqId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
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

  function start() {
    const base: NodeJS.ProcessEnv = {};
    for (const k of ENV_PASSTHROUGH) {
      if (process.env[k] !== undefined) base[k] = process.env[k];
    }
    const env: NodeJS.ProcessEnv = { ...base, ...opts.env };
    const p = spawn("node", [opts.mcpPath], { env, stdio: ["pipe", "pipe", "pipe"] });
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
      for (const [, h] of pending) h.reject(new Error("mcp subprocess exited"));
      pending.clear();
      // A killed process's `exit` event fires asynchronously and can land
      // after ensureConnected() has already spawned its replacement — guard
      // against a stale event from a superseded process clobbering the
      // reference to the one that's actually running now.
      if (proc === p) {
        proc = null;
        initialized = false;
      }
    });
    return p;
  }

  function sendRpc(method: string, params: unknown = {}): Promise<any> {
    if (!proc) throw new Error("mcp not running");
    const id = ++reqId;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc!.stdin.write(payload);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`mcp ${method} timeout after ${requestTimeout}ms`));
        }
      }, requestTimeout);
    });
  }

  // Connects (if needed) and completes the initialize handshake (if not done
  // yet on this process). Called before every tool/rpc call, not just at
  // startup — a subprocess crash mid-run (OOM, transient failure, ...) resets
  // `proc`/`initialized` via the exit handler above, and without re-checking
  // here every call after that would fail forever with "mcp not running"
  // instead of recovering, silently wedging a long-running caller like
  // market-maker's poll loop.
  async function ensureConnected(): Promise<void> {
    if (!proc) {
      proc = start();
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!initialized) {
      await sendRpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "sera-market-maker", version: "0.2.0" },
      });
      initialized = true;
    }
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
      if (proc) {
        proc.kill();
        proc = null;
        initialized = false;
      }
    },
    running() {
      return !!proc;
    },
  };
}
