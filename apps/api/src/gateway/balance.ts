import type { BalanceStatus, Channel } from "../domain/types.js";
import { apiUrl } from "./url.js";

export interface BalanceResult {
  balance: number | null;
  currency: string | null;
  status: BalanceStatus;
}

const ENDPOINTS = [
  "/dashboard/billing/credit_grants",
  "/v1/dashboard/billing/credit_grants",
  "/api/user/self",
  "/api/usage/token",
];

export async function fetchBalance(channel: Channel, apiKey: string, timeoutMs: number): Promise<BalanceResult> {
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 8_000));
    try {
      const response = await fetch(apiUrl(channel.baseUrl, endpoint), {
        headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const body = (await response.json()) as Record<string, unknown>;
      const parsed = parseBalance(body);
      if (parsed) return parsed;
    } catch {
      // Balance is optional; protocol health remains authoritative.
    } finally {
      clearTimeout(timer);
    }
  }
  return { balance: null, currency: null, status: "unknown" };
}

function parseBalance(body: Record<string, unknown>): BalanceResult | null {
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : body;
  const candidates = [
    data.total_available,
    data.balance,
    data.credit,
    data.remaining,
    data.quota,
  ];
  const raw = candidates.find((value) => typeof value === "number" || (typeof value === "string" && value.trim() !== ""));
  if (raw === undefined) return null;
  let balance = Number(raw);
  if (!Number.isFinite(balance)) return null;
  if (data.quota === raw && balance > 10_000) balance /= 500_000;
  return {
    balance,
    currency: typeof data.currency === "string" ? data.currency.toUpperCase() : "USD",
    status: balance <= 0 ? "exhausted" : balance < 1 ? "low" : "ok",
  };
}
