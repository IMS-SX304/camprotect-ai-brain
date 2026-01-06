// lib/webflow.ts
export type WebflowMoney = {
  value: number; // en "minor units" (ex: centimes)
  unit?: string; // ex: "EUR"
  currency?: string; // parfois présent
};

export function moneyToNumber(m?: WebflowMoney | null): number | null {
  if (!m || typeof m.value !== "number") return null;

  // Webflow renvoie généralement en centimes pour EUR/USD => 2 décimales
  // Pour être plus robuste : quelques monnaies sans décimales
  const c = (m.currency || m.unit || "").toUpperCase();
  const zeroDecimal = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);
  const divisor = zeroDecimal.has(c) ? 1 : 100;

  return Number((m.value / divisor).toFixed(zeroDecimal.has(c) ? 0 : 2));
}

export async function webflowJson(path: string, init?: RequestInit) {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing WEBFLOW_API_TOKEN");

  // IMPORTANT: base v2
  const url = `https://api.webflow.com/v2${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Webflow ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
