/**
 * On-chain payment confirmation — the trust boundary between the facilitator
 * and the vault.
 *
 * The facilitator (CDP or self-hosted) reports verify/settle results, but a
 * compromised or buggy facilitator could report success for a payment that
 * never happened — and the service would then hand out real FX from the vault
 * for free. This module independently confirms, via a JSON-RPC endpoint the
 * OPERATOR controls, that the settle transaction:
 *
 *   1. exists and succeeded (receipt status 0x1),
 *   2. emitted an ERC-20 Transfer of the payment asset TO the vault address
 *      with value >= the required amount,
 *   3. is buried under >= confirmationDepth blocks.
 *
 * Fail-closed: any RPC error, missing receipt, wrong recipient, short value,
 * or shallow confirmation returns { confirmed: false } — the swap must not
 * execute. Uses bare eth_* JSON-RPC over fetch: no new dependencies.
 */

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ConfirmConfig {
  rpcUrl: string;
  /** ERC-20 token contract the payment must move (e.g. USDC on the payment chain). */
  asset: string;
  /** Vault address the payment must land in. */
  vault: string;
  /** Minimum acceptable value in token base units (decimal string). */
  minAmountBaseUnits: string;
  confirmationDepth: number;
}

export interface ConfirmResult {
  confirmed: boolean;
  reason?: string;
  confirmations?: number;
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
}

interface RpcReceipt {
  status?: string;
  blockNumber?: string;
  logs?: RpcLog[];
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? "error"}`);
  return body.result as T;
}

function normalizeAddress(a: string): string {
  return a.toLowerCase();
}

/** 32-byte left-padded topic form of an address. */
function addressTopic(a: string): string {
  return "0x" + normalizeAddress(a).replace(/^0x/, "").padStart(64, "0");
}

/**
 * Check the receipt of `txHash` for a qualifying Transfer into the vault.
 * Single pass — callers poll via confirmPaymentOnChain.
 */
export async function checkOnce(cfg: ConfirmConfig, txHash: string): Promise<ConfirmResult> {
  try {
    const receipt = await rpc<RpcReceipt | null>(cfg.rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (!receipt) return { confirmed: false, reason: "receipt not found (tx pending or unknown)" };
    if (receipt.status !== "0x1") return { confirmed: false, reason: "transaction reverted" };
    if (!receipt.blockNumber) return { confirmed: false, reason: "receipt missing blockNumber" };

    const wantAsset = normalizeAddress(cfg.asset);
    const wantVault = addressTopic(cfg.vault);
    const need = BigInt(cfg.minAmountBaseUnits);

    const paid = (receipt.logs ?? []).some((log) => {
      if (normalizeAddress(log.address ?? "") !== wantAsset) return false;
      const t = log.topics ?? [];
      if (t.length < 3 || t[0] !== TRANSFER_TOPIC) return false;
      if (normalizeAddress(t[2] ?? "") !== wantVault) return false;
      try {
        return BigInt(log.data ?? "0x0") >= need;
      } catch {
        return false;
      }
    });
    if (!paid) {
      return {
        confirmed: false,
        reason: "no qualifying Transfer to vault found in receipt (asset/recipient/amount mismatch)",
      };
    }

    const headHex = await rpc<string>(cfg.rpcUrl, "eth_blockNumber", []);
    const confirmations = Number(BigInt(headHex) - BigInt(receipt.blockNumber)) + 1;
    if (confirmations < cfg.confirmationDepth) {
      return {
        confirmed: false,
        reason: `only ${confirmations}/${cfg.confirmationDepth} confirmations`,
        confirmations,
      };
    }
    return { confirmed: true, confirmations };
  } catch (e: any) {
    // Fail-closed on any RPC/parse error.
    return { confirmed: false, reason: `confirmation check failed: ${e?.message ?? String(e)}` };
  }
}

/**
 * Poll checkOnce until confirmed or the time budget runs out. The check is a
 * pure read — safe to repeat on request retries; delivery stays blocked until
 * it passes.
 */
export async function confirmPaymentOnChain(
  cfg: ConfirmConfig,
  txHash: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ConfirmResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let last: ConfirmResult = { confirmed: false, reason: "not checked" };
  for (;;) {
    last = await checkOnce(cfg, txHash);
    if (last.confirmed) return last;
    if (Date.now() + intervalMs > deadline) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
