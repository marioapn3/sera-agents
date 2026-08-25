/**
 * Payment-authorization binding — ties the on-chain confirmation to THIS
 * payment, closing the replay hole where a facilitator points txHash at
 * someone else's legitimate transfer.
 *
 * The x402 "exact" scheme payment header carries the buyer's signed EIP-3009
 * authorization: { from, to, value, validAfter, validBefore, nonce }. We parse
 * it (base64 JSON per x402 v1, raw JSON tolerated) and require the confirmed
 * Transfer log to match `from` and move exactly `value` to the vault. Parsing
 * is fail-closed in live mode: an authorization we cannot read is an
 * authorization we will not pay out against.
 */

export interface PaymentAuthorization {
  from: string;
  to: string;
  /** Token base units, decimal string. */
  value: string;
  nonce?: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d+$/;

function extract(obj: unknown): PaymentAuthorization | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, any>;
  // x402 v1 shape: { payload: { authorization: {...} } }; tolerate a bare
  // authorization object too.
  const auth = o.payload?.authorization ?? o.authorization ?? (o.from && o.to && o.value !== undefined ? o : null);
  if (!auth || typeof auth !== "object") return null;
  const from = String(auth.from ?? "");
  const to = String(auth.to ?? "");
  const value = String(auth.value ?? "");
  if (!ADDR.test(from) || !ADDR.test(to) || !UINT.test(value)) return null;
  return {
    from: from.toLowerCase(),
    to: to.toLowerCase(),
    value,
    nonce: typeof auth.nonce === "string" ? auth.nonce : undefined,
  };
}

/**
 * Parse the `<authorization>` part of the X-PAYMENT header. Returns null when
 * it cannot be read — callers in live mode must treat null as a hard reject.
 */
export function parsePaymentAuthorization(headerPart: string): PaymentAuthorization | null {
  const s = (headerPart ?? "").trim();
  if (!s) return null;
  // Raw JSON first (some clients skip base64).
  if (s.startsWith("{")) {
    try {
      return extract(JSON.parse(s));
    } catch {
      return null;
    }
  }
  try {
    const decoded = Buffer.from(s, "base64").toString("utf8");
    if (!decoded.trim().startsWith("{")) return null;
    return extract(JSON.parse(decoded));
  } catch {
    return null;
  }
}
