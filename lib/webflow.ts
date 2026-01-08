// lib/webflow.ts

export type WebflowMoney = {
  value: number; // minor units (ex: centimes)
  unit?: string; // ex: "EUR"
  currency?: string; // parfois présent
};

export function moneyToNumber(m?: WebflowMoney | null): number | null {
  if (!m || typeof m.value !== "number") return null;

  const c = (m.currency || m.unit || "").toUpperCase();
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
  const divisor = zeroDecimal.has(c) ? 1 : 100;

  return Number((m.value / divisor).toFixed(zeroDecimal.has(c) ? 0 : 2));
}

export async function webflowJson(path: string, init?: RequestInit) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  // base Webflow v2
  const url = `https://api.webflow.com/v2${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`Webflow ${res.status}: ${txt}`);
  }

  return txt ? JSON.parse(txt) : null;
}
