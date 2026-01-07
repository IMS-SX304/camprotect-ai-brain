// lib/webflow.ts

export type WebflowMoney = {
  value: number; // minor units (centimes)
  unit?: string; // "EUR"
  currency?: string; // parfois présent
};

export function moneyToNumber(m?: WebflowMoney | null): number | null {
  if (!m || typeof m.value !== "number") return null;
  const c = String(m.currency || m.unit || "").toUpperCase();

  // monnaies sans décimales (au cas où)
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
  const divisor = zeroDecimal.has(c) ? 1 : 100;

  return Number((m.value / divisor).toFixed(zeroDecimal.has(c) ? 0 : 2));
}

export async function webflowJson(path: string, init: RequestInit = {}) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  const url = `https://api.webflow.com/v2${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
    // Important en Next route handlers
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}
