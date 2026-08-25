/**
 * Anti-replay plumbing: the authorization parser (binding source of truth)
 * and the single-use settle-tx ledger.
 */
import { describe, it, expect } from "vitest";
import { parsePaymentAuthorization } from "../payment-binding.js";
import { makeStore } from "../state.js";

const FROM = "0xAaAa000000000000000000000000000000000001";
const VAULT = "0xBbBb000000000000000000000000000000000002";

const X402_HEADER_OBJ = {
  x402Version: 1,
  scheme: "exact",
  network: "eip155:11155111",
  payload: {
    signature: "0xsig",
    authorization: { from: FROM, to: VAULT, value: "1000000", nonce: "0x01" },
  },
};

describe("parsePaymentAuthorization", () => {
  it("parses the standard base64 x402 payload and lowercases addresses", () => {
    const header = Buffer.from(JSON.stringify(X402_HEADER_OBJ)).toString("base64");
    const a = parsePaymentAuthorization(header);
    expect(a).toEqual({ from: FROM.toLowerCase(), to: VAULT.toLowerCase(), value: "1000000", nonce: "0x01" });
  });

  it("parses raw JSON and a bare authorization object", () => {
    expect(parsePaymentAuthorization(JSON.stringify(X402_HEADER_OBJ))?.value).toBe("1000000");
    expect(
      parsePaymentAuthorization(JSON.stringify({ from: FROM, to: VAULT, value: "5" }))?.value,
    ).toBe("5");
  });

  it("returns null (fail-closed upstream) for garbage, non-address fields, and non-uint values", () => {
    for (const bad of [
      "",
      "not-base64-json",
      Buffer.from("[1,2,3]").toString("base64"),
      JSON.stringify({ payload: { authorization: { from: "nope", to: VAULT, value: "1" } } }),
      JSON.stringify({ payload: { authorization: { from: FROM, to: VAULT, value: "-5" } } }),
      JSON.stringify({ payload: { authorization: { from: FROM, to: VAULT, value: "1.5" } } }),
    ]) {
      expect(parsePaymentAuthorization(bad)).toBeNull();
    }
  });
});

describe("claimTx — one settle tx authorizes at most one delivery", () => {
  it("first claim wins; same payment may re-claim (retry-idempotent); others are refused", () => {
    const store = makeStore(undefined, 100);
    expect(store.claimTx("0xABC", "payment-1")).toBe(true);
    expect(store.claimTx("0xabc", "payment-1")).toBe(true); // case-insensitive idempotent retry
    expect(store.claimTx("0xABC", "payment-2")).toBe(false); // replay across payments refused
    expect(store.claimTx("0xdef", "payment-2")).toBe(true);
  });
});
